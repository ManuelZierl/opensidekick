// OpenSidekick background service worker (ES module).
// Owns conversation state, routes messages between the side panel and the agent
// loop, and mediates permission prompts.

import { MSG, STORAGE_KEY, SESSION_CONVO_KEY } from "../common/constants.js";
import { loadConfig, getActiveProvider, setSitePermission, loadTaskRuns, recordTaskRun } from "./storage.js";
import { resolveSource, isNoteworthyChange, featureEnabled, thresholdFor } from "./decisions.js";
import { runAgent } from "./agent.js";
import { detachAll } from "./cdp.js";
import { ensureContentScript } from "./tools.js";
import { applyMigrations } from "./migrations.js";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
let conversation = []; // normalized message history for the current chat
let conversationLoaded = false; // restored from storage.session once per worker life
let currentRun = null; // { controller: AbortController }
const pendingPermissions = new Map(); // id -> resolve fn
const pendingPlans = new Map(); // id -> resolve fn
let permissionSeq = 0;
let pendingSeed = null; // task text queued by a context-menu action
let recording = null; // { steps, tabId, startUrl, lastClickAt, lastUrl }
let keepAliveTimer = null;

// MV3 terminates an idle service worker after ~30s. While a task is running —
// especially while we're parked awaiting the user's answer to a permission or
// plan prompt — ping a chrome API every 20s to reset that idle timer, so the run
// (and its in-memory pending prompts) survive until the user responds. Without
// this, a slow "Allow" click lands on a fresh worker that has lost the run: the
// click resolves nothing and Stop has no run to abort, leaving a stuck panel.
function startKeepAlive() {
  if (keepAliveTimer != null) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer != null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// -------------------------------------------------------------------------
// Conversation persistence — MV3 kills the idle worker BETWEEN user prompts
// (the keepalive only runs during a task), which used to wipe the in-memory
// conversation: the next prompt started from scratch. Persist the chat to
// chrome.storage.session (survives worker restarts, clears when Chrome closes)
// and restore it lazily on the next worker.
// -------------------------------------------------------------------------
async function ensureConversationLoaded() {
  if (conversationLoaded) return;
  conversationLoaded = true;
  if (conversation.length) return; // this worker already has a live chat
  try {
    const raw = await chrome.storage.session.get(SESSION_CONVO_KEY);
    const stored = raw[SESSION_CONVO_KEY];
    if (Array.isArray(stored) && stored.length) conversation = stored;
  } catch {
    /* session storage unavailable — continue with an empty chat */
  }
}

async function persistConversation() {
  // Screenshots are large and only matter within the turn they were taken in —
  // strip them so the chat stays comfortably inside the session-storage quota.
  const strip = (msgs) =>
    msgs.map((m) =>
      m.images && m.images.length
        ? { ...m, images: undefined, content: m.content || "(a screenshot was attached here; it is not retained across sessions)" }
        : m,
    );
  try {
    await chrome.storage.session.set({ [SESSION_CONVO_KEY]: strip(conversation) });
  } catch {
    // Likely over quota (very long chat) — keep only the recent tail.
    try {
      await chrome.storage.session.set({ [SESSION_CONVO_KEY]: strip(conversation.slice(-20)) });
    } catch {
      /* give up quietly; worst case the next worker starts fresh */
    }
  }
}

async function clearConversation() {
  conversation = [];
  conversationLoaded = true;
  try {
    await chrome.storage.session.remove(SESSION_CONVO_KEY);
  } catch {
    /* ignore */
  }
}

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: "ask-opensidekick",
    title: 'Ask OpenSidekick about "%s"',
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "summarize-page",
    title: "Summarize this page with OpenSidekick",
    contexts: ["page"],
  });
  runMigrations();
  reconcileAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  runMigrations();
  reconcileAlarms();
});

// Apply one-time config migrations to an existing stored config. Does nothing on
// a fresh install (no stored config yet), so it can't clobber a config that's
// being written concurrently at first run.
async function runMigrations() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  if (!raw[STORAGE_KEY]) return;
  const { config, changed } = applyMigrations(raw[STORAGE_KEY]);
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

// Re-register scheduled-task alarms whenever the config changes.
const SCHED_PREFIX = "osk:sched:";
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) reconcileAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(SCHED_PREFIX)) runScheduledById(alarm.name.slice(SCHED_PREFIX.length));
});

// Idempotent on purpose: an alarm that already has the right period is left
// exactly as it is, including its next fire time. Clearing and re-creating every
// alarm on each config change pushed every task's next run out by its full
// interval — so anything that wrote the config regularly could starve a
// long-interval task indefinitely (an hourly task resetting a daily one).
async function reconcileAlarms() {
  const config = await loadConfig();
  const wanted = new Map();
  for (const t of config.scheduledTasks || []) {
    const minutes = Number(t.intervalMinutes) || 0;
    if (t.enabled && minutes > 0) wanted.set(SCHED_PREFIX + t.id, minutes);
  }
  for (const a of await chrome.alarms.getAll()) {
    if (!a.name.startsWith(SCHED_PREFIX)) continue;
    // `has` first: a stray one-shot alarm (no period) for a deleted task must
    // not match an undefined `wanted` entry and survive as "already correct".
    if (wanted.has(a.name) && wanted.get(a.name) === a.periodInMinutes) wanted.delete(a.name); // already correct
    else await chrome.alarms.clear(a.name); // stale period, or the task is gone
  }
  for (const [name, minutes] of wanted) {
    chrome.alarms.create(name, { periodInMinutes: minutes, delayInMinutes: minutes });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let task = null;
  if (info.menuItemId === "ask-opensidekick" && info.selectionText) {
    task = `Regarding this selected text from the page:\n\n"""${info.selectionText}"""\n\nPlease help me with it.`;
  } else if (info.menuItemId === "summarize-page") {
    task = "Summarize the current page for me.";
  }
  if (!task) return;
  pendingSeed = task;
  if (tab && tab.id != null) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      /* user may need to click the icon */
    }
  }
  // Nudge an already-open panel to pick up the seed.
  chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, kind: "seed", task }).catch(() => {});
});

// -------------------------------------------------------------------------
// Messaging
// -------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case MSG.GET_STATE: {
      handleGetState().then(sendResponse);
      return true;
    }
    case MSG.RUN_TASK: {
      handleRunTask(msg).then(sendResponse);
      return true;
    }
    case MSG.NEW_CHAT: {
      clearConversation().then(() => sendResponse({ ok: true }));
      return true;
    }
    case MSG.STOP_TASK: {
      if (currentRun) currentRun.controller.abort();
      // Also cancel any pending permission or plan prompt.
      for (const [, resolve] of pendingPermissions) resolve("decline");
      pendingPermissions.clear();
      for (const [, resolve] of pendingPlans) resolve(false);
      pendingPlans.clear();
      // Always un-stick the panel: if the run is live its finally also emits idle
      // (harmless), and if the worker restarted there's no run to end otherwise.
      if (!currentRun && !recording) stopKeepAlive();
      emit({ kind: "idle" });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PERMISSION_RESPONSE: {
      const resolve = pendingPermissions.get(msg.id);
      if (resolve) {
        pendingPermissions.delete(msg.id);
        resolve(msg.choice);
      } else if (!currentRun) {
        // The run was lost (e.g. the worker restarted before this answer landed).
        // Nothing to resolve — reset the panel instead of leaving it "Working".
        emit({ kind: "idle" });
      }
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PLAN_RESPONSE: {
      const resolve = pendingPlans.get(msg.id);
      if (resolve) {
        pendingPlans.delete(msg.id);
        resolve(!!msg.approved);
      } else if (!currentRun) {
        emit({ kind: "idle" });
      }
      sendResponse({ ok: true });
      return false;
    }
    case MSG.RUN_SCHEDULED: {
      runScheduledById(msg.id).then(() => sendResponse({ ok: true }));
      return true;
    }
    case MSG.START_RECORDING: {
      startRecording().then(sendResponse);
      return true;
    }
    case MSG.STOP_RECORDING: {
      sendResponse(stopRecording());
      return false;
    }
    case MSG.CS_STEP: {
      if (recording && msg.step) pushStep(msg.step);
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});

async function handleGetState() {
  const { config, provider } = await getActiveProvider();
  await ensureConversationLoaded();
  const seed = pendingSeed;
  pendingSeed = null;
  return {
    ok: true,
    configured: !!(provider && config.activeModel),
    providerName: provider ? provider.name : null,
    model: config.activeModel || null,
    autonomy: config.settings.autonomy,
    running: !!currentRun,
    recording: !!recording,
    recordingSteps: recording ? recording.steps.length : 0,
    seed,
    history: conversationHistory(),
  };
}

// A compact, renderable projection of the conversation for the side panel —
// user prompts and visible assistant text (incl. a finish tool's summary).
function conversationHistory() {
  const out = [];
  for (const m of conversation) {
    if (m.role === "user" && typeof m.content === "string" && m.content && !m.images && !m.internal) {
      out.push({ role: "user", text: m.content });
    } else if (m.role === "assistant") {
      let text = (m.content || "").trim();
      if (!text && m.toolCalls) {
        const fin = m.toolCalls.find((t) => t.name === "finish" && t.args && t.args.summary);
        if (fin) text = String(fin.args.summary);
      }
      if (text) out.push({ role: "assistant", text });
    }
  }
  return out;
}

async function handleRunTask(msg) {
  if (currentRun) return { ok: false, error: "A task is already running." };

  const { config, provider } = await getActiveProvider();
  if (!provider) {
    emit({ kind: "error", error: "No provider configured. Open Settings to add one." });
    emit({ kind: "idle" });
    return { ok: false, error: "not-configured" };
  }
  if (!config.activeModel) {
    emit({ kind: "error", error: "No model selected. Open Settings to choose a model." });
    emit({ kind: "idle" });
    return { ok: false, error: "no-model" };
  }

  if (msg.newChat) await clearConversation();
  else await ensureConversationLoaded();
  conversation.push({ role: "user", content: msg.task });
  emit({ kind: "user_echo", text: msg.task });

  const controller = new AbortController();
  currentRun = { controller };

  const initialTabId = await getActiveContentTabId();
  if (initialTabId == null) {
    emit({ kind: "error", error: "Could not find an active tab to work on." });
    emit({ kind: "idle" });
    currentRun = null;
    return { ok: false, error: "no-tab" };
  }

  // Keep the worker alive for the whole run (incl. while awaiting prompts).
  startKeepAlive();

  // Run the loop (do not await the sendResponse on it — events stream async).
  runAgent({
    conversation,
    config,
    provider,
    initialTabId,
    signal: controller.signal,
    emit,
    requestPermission,
    requestPlanApproval,
    saveSitePermission: (origin, value) => setSitePermission(origin, value),
  })
    .catch((e) => emit({ kind: "error", error: String(e.message || e) }))
    .finally(async () => {
      // Detach the debugger (removes the "debugging this browser" banner).
      await detachAll().catch(() => {});
      await persistConversation(); // so the chat survives worker termination
      currentRun = null;
      if (!recording) stopKeepAlive(); // an active recording still needs it
      emit({ kind: "idle" });
    });

  return { ok: true };
}

// Ask the side panel to approve an action. Resolves to "once" | "always" | "decline".
function requestPermission(details) {
  const id = ++permissionSeq;
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
    chrome.runtime
      .sendMessage({ type: MSG.PERMISSION_REQUEST, id, ...details })
      .catch(() => {
        // Side panel not reachable — fail safe by declining.
        pendingPermissions.delete(id);
        resolve("decline");
      });
  });
}

// -------------------------------------------------------------------------
// Workflow recording — capture user actions on a tab as steps
// -------------------------------------------------------------------------
async function startRecording() {
  const tabId = await getActiveContentTabId();
  if (tabId == null) return { ok: false, error: "No page to record on." };
  let startUrl = "";
  try {
    startUrl = (await chrome.tabs.get(tabId)).url || "";
  } catch {
    /* ignore */
  }
  recording = { steps: [], tabId, startUrl, lastClickAt: 0, lastUrl: startUrl };
  chrome.tabs.onUpdated.addListener(recordingOnUpdated);
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: MSG.CS_RECORD, on: true }).catch(() => {});
  // A quiet stretch while the user reads the page would otherwise let MV3 kill
  // the worker — taking the in-memory recording with it.
  startKeepAlive();
  return { ok: true, startUrl };
}

function stopRecording() {
  chrome.tabs.onUpdated.removeListener(recordingOnUpdated);
  const result = recording
    ? { ok: true, steps: recording.steps, startUrl: recording.startUrl }
    : { ok: true, steps: [], startUrl: "" };
  if (recording) chrome.tabs.sendMessage(recording.tabId, { type: MSG.CS_RECORD, on: false }).catch(() => {});
  recording = null;
  if (!currentRun) stopKeepAlive(); // a running task still needs the keepalive
  return result;
}

function pushStep(step) {
  if (!recording) return;
  if (step.action === "click") recording.lastClickAt = Date.now();
  recording.steps.push(step);
  chrome.runtime.sendMessage({ type: MSG.RECORDING_STEP, step, count: recording.steps.length }).catch(() => {});
}

function recordingOnUpdated(tabId, changeInfo) {
  if (!recording || tabId !== recording.tabId) return;
  if (changeInfo.url && changeInfo.url !== recording.lastUrl) {
    recording.lastUrl = changeInfo.url;
    // Skip navigations that a just-recorded click caused (avoid duplicates).
    const causedByClick = Date.now() - (recording.lastClickAt || 0) < 1500;
    if (!causedByClick && /^https?:/i.test(changeInfo.url)) {
      pushStep({ action: "navigate", description: `Go to ${changeInfo.url}` });
    }
  }
  if (changeInfo.status === "complete") {
    // The fresh content script on the new page needs re-arming.
    chrome.tabs.sendMessage(tabId, { type: MSG.CS_RECORD, on: true }).catch(() => {});
  }
}

// -------------------------------------------------------------------------
// Scheduled tasks (run unattended via alarms, or "run now" from Settings)
// -------------------------------------------------------------------------
async function runScheduledById(id) {
  const config = await loadConfig();
  const task = (config.scheduledTasks || []).find((t) => t.id === id);
  if (task) await runScheduledTask(task);
}

async function runScheduledTask(task) {
  if (currentRun) {
    notify(task.name, "Skipped — another task was already running.");
    return;
  }
  const { config, provider } = await getActiveProvider();
  if (!provider || !config.activeModel) {
    notify(task.name, "Skipped — no model configured.");
    return;
  }

  let tabId;
  try {
    if (task.url) {
      const tab = await chrome.tabs.create({ url: normalizeUrl(task.url), active: true });
      tabId = tab.id;
      await waitTabComplete(tabId);
    } else {
      tabId = await getActiveContentTabId();
    }
  } catch {
    notify(task.name, "Couldn't open the target page.");
    return;
  }
  if (tabId == null) {
    notify(task.name, "No page available to run on.");
    return;
  }

  const controller = new AbortController();
  currentRun = { controller };
  startKeepAlive();
  const conversation = [{ role: "user", content: task.prompt }];
  let summary = "";
  let errored = false;
  try {
    await runAgent({
      conversation,
      // Unattended runs act without asking (no one is watching to approve).
      config: { ...config, settings: { ...config.settings, autonomy: "auto" } },
      provider,
      initialTabId: tabId,
      signal: controller.signal,
      emit: (ev) => {
        if (ev.kind === "finish" && ev.summary) summary = ev.summary;
        else if (ev.kind === "assistant_end" && ev.content) summary = ev.content;
        else if (ev.kind === "error") {
          errored = true;
          if (!summary) summary = "Error: " + ev.error;
        } else if (ev.kind === "tool_end" && ev.ok === false && /Declined by user/.test(ev.summary || "")) {
          // Nobody is here to answer a confirmation, so requestPermission below
          // declines — which cuts the run short. That is a failure, not a quiet
          // success: without this the run could be reported as "Done." or, with
          // change-only notifications on, compared away entirely.
          errored = true;
          if (!summary) {
            summary = `Stopped: this needed your confirmation for ${ev.name}, and unattended runs can't ask.`;
          }
        }
      },
      // No UI to answer prompts — sensitive actions are declined (safe default).
      requestPermission: async () => "decline",
      requestPlanApproval: async () => false,
      saveSitePermission: () => {},
    });
  } catch (e) {
    errored = true;
    summary = "Error: " + (e.message || e);
  } finally {
    await detachAll().catch(() => {});
    currentRun = null;
    if (!recording) stopKeepAlive();
  }
  await finishScheduledRun(task, summary, errored);
}

// Notify (or, with the change-only smart check on, stay quiet when this run said
// the same thing as the last one), then remember what this run produced so the
// next one has something to compare against.
async function finishScheduledRun(task, summary, errored) {
  const title = task.name || "Scheduled task";
  const message = summary || "Done.";
  const config = await loadConfig();
  const prev = (await loadTaskRuns())[task.id] || {};
  // A failed run always speaks up, and so does the very first run of a task:
  // there is nothing to compare it against yet.
  const src = errored ? null : resolveSource(config);
  const changeOnly = !!src && featureEnabled(config, "changeOnly") && prev.lastResult != null;

  let suppressed = Number(prev.suppressedCount) || 0;
  let notifiedChange = false;
  if (!changeOnly) {
    notify(title, message);
    notifiedChange = true;
  } else {
    const r = await isNoteworthyChange(src, {
      taskName: task.name,
      prompt: task.prompt,
      previous: prev.lastResult,
      current: summary,
    });
    // null = the check didn't answer; fall back to today's behavior and notify.
    if (r === null || r.probability >= thresholdFor(config)) {
      notify(title, message);
      notifiedChange = true;
    } else {
      suppressed++;
      // Every sixth quiet run, say so — a task that never speaks looks broken.
      if (suppressed % 6 === 0) notify(title, "(No change in the last 6 runs.) " + message);
    }
  }

  // Persisted even when the feature is off: it costs nothing and means turning
  // it on later has a baseline to work from.
  try {
    await recordTaskRun(
      task.id,
      {
        lastResult: String(summary || "").slice(0, 2000),
        lastRunAt: Date.now(),
        suppressedCount: notifiedChange ? 0 : suppressed,
      },
      (config.scheduledTasks || []).map((t) => t.id),
    );
  } catch {
    /* the notification already went out; losing the baseline isn't fatal */
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "OpenSidekick — " + (title || "Scheduled task"),
      message: String(message || "").slice(0, 400),
    });
  } catch {
    /* notifications may be unavailable */
  }
}

function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  return /^[a-z]+:\/\//i.test(s) ? s : "https://" + s;
}

function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => t && t.status === "complete" && finish()).catch(() => {});
  });
}

// Ask the side panel to approve the agent's plan. Resolves to true/false.
function requestPlanApproval(plan) {
  const id = ++permissionSeq;
  return new Promise((resolve) => {
    pendingPlans.set(id, resolve);
    chrome.runtime.sendMessage({ type: MSG.PLAN_REQUEST, id, plan }).catch(() => {
      pendingPlans.delete(id);
      resolve(false);
    });
  });
}

function emit(event) {
  chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, ...event }).catch(() => {});
}

async function getActiveContentTabId() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => t.url && /^https?:/i.test(t.url)) || tabs[0];
  return tab ? tab.id : null;
}
