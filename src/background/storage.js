// Thin wrapper over chrome.storage.local for the OpenSidekick config object.
// All secrets (API keys) live here, in the extension's local storage only —
// they are never sent anywhere except directly to the provider endpoint the
// user configured.

import {
  STORAGE_KEY,
  TASK_RUNS_KEY,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  SESSIONS_INDEX_KEY,
  SESSION_BODY_PREFIX,
  PROMPT_HISTORY_KEY,
} from "../common/constants.js";
import { readIndex, emptyIndex } from "./sessions.js";

export async function loadConfig() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY];
  if (!stored) return structuredClone(DEFAULT_CONFIG);
  // Merge to tolerate configs written by older versions.
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...stored,
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    sitePermissions: { ...(stored.sitePermissions || {}) },
    providers: Array.isArray(stored.providers) ? stored.providers : [],
    prompts: Array.isArray(stored.prompts) ? stored.prompts : [],
    scheduledTasks: Array.isArray(stored.scheduledTasks) ? stored.scheduledTasks : [],
    workflows: Array.isArray(stored.workflows) ? stored.workflows : [],
    mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers : [],
    // Nested, so the top-level spread above isn't enough: a config saved before
    // a feature switch existed must still come back with every switch present
    // (and off), not undefined.
    decisions: {
      ...DEFAULT_CONFIG.decisions,
      ...(stored.decisions || {}),
      features: { ...DEFAULT_CONFIG.decisions.features, ...((stored.decisions || {}).features || {}) },
    },
  };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

// Scheduled-run bookkeeping, keyed by task id: { lastResult, lastRunAt,
// suppressedCount }. Kept out of the config object on purpose — see
// TASK_RUNS_KEY — so finishing a run never rewrites the config that drives the
// alarms, and the options page can't clobber it with a stale snapshot.
export async function loadTaskRuns() {
  try {
    const raw = await chrome.storage.local.get(TASK_RUNS_KEY);
    const stored = raw[TASK_RUNS_KEY];
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

export async function recordTaskRun(id, run, knownIds) {
  const all = await loadTaskRuns();
  all[id] = run;
  // Deleting a task in Settings shouldn't leave its last result behind forever;
  // prune while we're writing anyway.
  if (Array.isArray(knownIds)) {
    for (const k of Object.keys(all)) if (!knownIds.includes(k)) delete all[k];
  }
  await chrome.storage.local.set({ [TASK_RUNS_KEY]: all });
  return all;
}

export async function getActiveProvider() {
  const config = await loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId) || null;
  return { config, provider };
}

export async function setSitePermission(origin, value) {
  const config = await loadConfig();
  if (value === null) {
    delete config.sitePermissions[origin];
  } else {
    config.sitePermissions[origin] = value;
  }
  await saveConfig(config);
  return config;
}

// Chat history: an index key plus one key per chat body (see SESSIONS_INDEX_KEY).
// The service worker is the only writer; it serializes these calls itself.
export async function loadSessionIndex() {
  try {
    const raw = await chrome.storage.local.get(SESSIONS_INDEX_KEY);
    return readIndex(raw[SESSIONS_INDEX_KEY]);
  } catch {
    return emptyIndex();
  }
}

export async function loadSessionBody(id) {
  try {
    const raw = await chrome.storage.local.get(SESSION_BODY_PREFIX + id);
    const body = raw[SESSION_BODY_PREFIX + id];
    if (!body || !Array.isArray(body.messages)) return null;
    return body.trimmed ? { id, messages: body.messages, trimmed: true } : { id, messages: body.messages };
  } catch {
    return null;
  }
}

// One set() for the index and the body, so a worker killed mid-save can't
// leave one updated without the other. Rejects on quota errors, which the
// caller handles.
export async function writeSession(index, body) {
  const items = { [SESSIONS_INDEX_KEY]: index };
  if (body) items[SESSION_BODY_PREFIX + body.id] = body;
  await chrome.storage.local.set(items);
}

export async function writeSessionIndex(index) {
  await chrome.storage.local.set({ [SESSIONS_INDEX_KEY]: index });
}

export async function removeSessionBodies(ids) {
  if (!ids || !ids.length) return;
  await chrome.storage.local.remove(ids.map((id) => SESSION_BODY_PREFIX + id));
}

// getKeys() only exists in newer Chrome; reading everything once is the fallback.
export async function listLocalKeys() {
  if (typeof chrome.storage.local.getKeys === "function") return await chrome.storage.local.getKeys();
  return Object.keys(await chrome.storage.local.get(null));
}

// Every saved chat and the prompt history, as the "keep history" switch promises.
export async function clearAllHistory() {
  const bodies = (await listLocalKeys()).filter((k) => k.startsWith(SESSION_BODY_PREFIX));
  await chrome.storage.local.remove([SESSIONS_INDEX_KEY, PROMPT_HISTORY_KEY, ...bodies]);
}
