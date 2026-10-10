// Options page: manage providers, model selection, behavior, and site rules.

import { PROVIDER_PRESETS, DEFAULT_CONFIG, DEFAULT_SETTINGS, MSG, STORAGE_KEY } from "../common/constants.js";
import { loadConfig, saveConfig } from "../background/storage.js";
import { listModels, testModel } from "../background/providers.js";
import { connectServer, listTools } from "../background/mcp.js";
import {
  DEFAULT_DECISION_MODELS,
  OPENROUTER_DECISIONS_URL,
  TYPESAFE_DECISIONS_URL,
  isOpenRouterUrl,
  resolveSource,
  testDecisions,
} from "../background/decisions.js";

let config;

const $ = (sel) => document.querySelector(sel);
const presetSelect = $("#preset-select");
const providerList = $("#provider-list");
const noProviders = $("#no-providers");
const permList = $("#perm-list");
const noPerms = $("#no-perms");
const toast = $("#toast");

init();

async function init() {
  config = await loadConfig();

  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }

  $("#add-provider").addEventListener("click", addProviderFromPreset);
  $("#add-prompt").addEventListener("click", addPrompt);
  $("#add-sched").addEventListener("click", addSched);
  $("#add-mcp").addEventListener("click", addMcp);
  wireSettings();
  wireDecisions();
  renderAll();

  // This page holds `config` in memory and persist() writes the WHOLE object.
  // Other surfaces also write the config while this page is open — the side
  // panel saves workflows and switches autonomy, the agent grants per-site
  // permissions. Without reloading here, the next persist() would clobber those
  // with our stale snapshot (a saved workflow used to vanish this way). So on
  // any external write, re-read and re-render.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    if (selfWrites > 0) {
      selfWrites--; // our own persist() — in-memory config is already current
      return;
    }
    config = await loadConfig();
    renderAll();
  });
}

function renderAll() {
  renderProviders();
  renderSettings();
  renderPermissions();
  renderPrompts();
  renderScheduled();
  renderWorkflows();
  renderMcp();
  // renderProviders() ends with renderDecisions() — the smart-checks section
  // reads the provider list, so it is always rendered from there.
}

// -------------------------------------------------------------------------
// Providers
// -------------------------------------------------------------------------
function addProviderFromPreset() {
  const presetId = presetSelect.value;
  if (!presetId) return;
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const provider = {
    id: crypto.randomUUID(),
    name: preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.defaultModel || "",
    keyUrl: preset.keyUrl || "",
    models: [],
  };
  config.providers.push(provider);
  // Make it active if it's the first one.
  if (!config.activeProviderId) {
    config.activeProviderId = provider.id;
    config.activeModel = provider.model;
  }
  presetSelect.value = "";
  persist();
  renderProviders();
}

function renderProviders() {
  providerList.innerHTML = "";
  noProviders.hidden = config.providers.length > 0;

  const tpl = $("#provider-template");
  for (const provider of config.providers) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = provider.id;
    const active = config.activeProviderId === provider.id;
    node.classList.toggle("active", active);

    node.querySelector(".pname").textContent = provider.name;
    node.querySelector(".type-badge").textContent = provider.type;
    const radio = node.querySelector('input[name="active-provider"]');
    radio.checked = active;
    radio.addEventListener("change", () => setActive(provider.id));

    const baseUrl = node.querySelector(".base-url");
    baseUrl.value = provider.baseUrl;
    baseUrl.addEventListener("change", () => {
      provider.baseUrl = baseUrl.value.trim();
      persist();
      // Whether this provider can lend its key to smart checks depends on the
      // URL and the key, so section 8 has to be re-rendered here: persist()
      // suppresses the storage.onChanged re-render for our own writes.
      renderDecisions();
    });

    const keyInput = node.querySelector(".api-key");
    keyInput.value = provider.apiKey || "";
    keyInput.addEventListener("change", () => {
      provider.apiKey = keyInput.value.trim();
      persist();
      renderDecisions();
    });
    const keyLink = node.querySelector(".key-link");
    if (provider.keyUrl) {
      keyLink.href = provider.keyUrl;
      keyLink.hidden = false;
    }

    const modelInput = node.querySelector(".model");
    const datalist = node.querySelector("datalist");
    const listId = "models-" + provider.id;
    datalist.id = listId;
    modelInput.setAttribute("list", listId);
    modelInput.value = provider.model || "";
    fillDatalist(datalist, provider.models);
    modelInput.addEventListener("change", () => {
      provider.model = modelInput.value.trim();
      if (config.activeProviderId === provider.id) config.activeModel = provider.model;
      persist();
    });

    const fetchBtn = node.querySelector(".fetch-models");
    const fetchStatus = node.querySelector(".fetch-status");
    fetchBtn.addEventListener("click", () => fetchModels(provider, fetchBtn, fetchStatus, datalist));

    const testBtn = node.querySelector(".test-model");
    const testStatus = node.querySelector(".test-status");
    testBtn.addEventListener("click", () => runModelTest(provider, modelInput, testBtn, testStatus));

    node.querySelector(".delete-provider").addEventListener("click", () => removeProvider(provider.id));

    providerList.appendChild(node);
  }
  // The smart-checks key source points at one of these, by id.
  renderDecisions();
}

function setActive(id) {
  config.activeProviderId = id;
  const provider = config.providers.find((p) => p.id === id);
  if (provider) config.activeModel = provider.model;
  persist();
  renderProviders();
}

function removeProvider(id) {
  config.providers = config.providers.filter((p) => p.id !== id);
  if (config.activeProviderId === id) {
    config.activeProviderId = config.providers[0]?.id || null;
    config.activeModel = config.providers[0]?.model || null;
  }
  persist();
  renderProviders();
}

async function fetchModels(provider, btn, status, datalist) {
  btn.disabled = true;
  status.textContent = "Fetching…";
  status.style.color = "var(--muted)";
  try {
    const models = await listModels(provider);
    provider.models = models;
    fillDatalist(datalist, models);
    persist();
    status.textContent = `Found ${models.length} models. Start typing to filter.`;
  } catch (e) {
    status.textContent = "Could not fetch models: " + (e.message || e);
    status.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

async function runModelTest(provider, modelInput, btn, statusEl) {
  const model = (modelInput.value || provider.model || "").trim();
  statusEl.hidden = false;
  if (!model) {
    statusEl.innerHTML = `<span class="test-line fail">Enter a model id first.</span>`;
    return;
  }
  if (!provider.baseUrl) {
    statusEl.innerHTML = `<span class="test-line fail">Set the provider's Base URL first.</span>`;
    return;
  }
  btn.disabled = true;
  statusEl.innerHTML = `<span class="test-line muted">Testing <code>${escapeHtml(model)}</code> — text, tools, vision…</span>`;
  try {
    const r = await testModel({ ...provider, model }, model);
    const icon = { ok: "✓", warn: "⚠", fail: "✗" };
    const line = (label, res) =>
      `<span class="test-line ${res.status}">${icon[res.status]} <strong>${label}</strong> — ${escapeHtml(res.detail)}</span>`;
    let verdict = "";
    if (r.tools.status === "ok" && (r.vision.status === "ok" || r.vision.status === "warn")) {
      verdict = `<span class="test-line ok">This model can drive OpenSidekick.${r.vision.status === "ok" ? " Vision works too." : ""}</span>`;
    } else if (r.tools.status !== "ok") {
      verdict = `<span class="test-line fail">Tools didn't work — the agent can't act with this model. Pick a tool-capable one.</span>`;
    } else if (r.vision.status === "fail") {
      verdict = `<span class="test-line warn">Tools work, but this model can't see images. Fine for text tasks; turn off Vision or pick a multimodal model for image work.</span>`;
    }
    statusEl.innerHTML = [line("Text", r.text), line("Tools", r.tools), line("Vision", r.vision), verdict].join("");
  } catch (e) {
    statusEl.innerHTML = `<span class="test-line fail">Test failed: ${escapeHtml(String(e.message || e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function fillDatalist(datalist, models) {
  datalist.innerHTML = "";
  for (const m of models || []) {
    const opt = document.createElement("option");
    opt.value = m;
    datalist.appendChild(opt);
  }
}

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------
function wireSettings() {
  document.querySelectorAll('input[name="autonomy"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.autonomy = r.value;
      persist();
    }),
  );
  document.querySelectorAll('input[name="siteAccess"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.siteAccess = r.value;
      persist();
    }),
  );
  $("#max-steps").addEventListener("change", (e) => {
    config.settings.maxSteps = clampInt(e.target.value, 1, 100, DEFAULT_SETTINGS.maxSteps);
    persist();
  });
  $("#max-tokens").addEventListener("change", (e) => {
    config.settings.maxTokens = clampInt(e.target.value, 256, 128000, DEFAULT_SETTINGS.maxTokens);
    persist();
  });
  const temp = $("#temperature");
  temp.addEventListener("input", () => {
    $("#temp-value").textContent = Number(temp.value).toFixed(2);
  });
  temp.addEventListener("change", () => {
    config.settings.temperature = Number(temp.value);
    persist();
  });
  $("#enable-vision").addEventListener("change", (e) => {
    config.settings.enableVision = e.target.checked;
    persist();
  });
  $("#enable-js").addEventListener("change", (e) => {
    config.settings.enableJsTool = e.target.checked;
    persist();
  });
  $("#enable-cdp").addEventListener("change", (e) => {
    config.settings.enableCdp = e.target.checked;
    persist();
  });
}

function renderSettings() {
  const s = config.settings;
  const radio = document.querySelector(`input[name="autonomy"][value="${s.autonomy}"]`);
  if (radio) radio.checked = true;
  const saRadio = document.querySelector(`input[name="siteAccess"][value="${s.siteAccess || "all"}"]`);
  if (saRadio) saRadio.checked = true;
  $("#max-steps").value = s.maxSteps;
  $("#max-tokens").value = s.maxTokens;
  $("#temperature").value = s.temperature;
  $("#temp-value").textContent = Number(s.temperature).toFixed(2);
  $("#enable-vision").checked = !!s.enableVision;
  $("#enable-js").checked = !!s.enableJsTool;
  $("#enable-cdp").checked = !!s.enableCdp;
}

// -------------------------------------------------------------------------
// Smart checks (Jev decision model)
// -------------------------------------------------------------------------
const DECISION_FEATURES = [
  ["#dec-f-action", "action"],
  ["#dec-f-injection", "injection"],
  ["#dec-f-change", "changeOnly"],
];

// Older configs predate this block, and a half-written one would lose the
// feature switches — fill both in before reading or writing them.
function decisions() {
  if (!config.decisions) config.decisions = structuredClone(DEFAULT_CONFIG.decisions);
  if (!config.decisions.features) config.decisions.features = { ...DEFAULT_CONFIG.decisions.features };
  return config.decisions;
}

function wireDecisions() {
  $("#dec-enabled").addEventListener("change", (e) => {
    decisions().enabled = e.target.checked;
    persist();
    renderDecisions();
  });
  document.querySelectorAll('input[name="dec-source"]').forEach((r) =>
    r.addEventListener("change", () => {
      decisions().source = r.value;
      persist();
      renderDecisions();
    }),
  );
  $("#dec-provider").addEventListener("change", (e) => {
    decisions().providerId = e.target.value || null;
    persist();
    renderDecisions();
  });
  $("#dec-key").addEventListener("change", (e) => {
    decisions().apiKey = e.target.value.trim();
    persist();
    renderDecisions();
  });
  $("#dec-model").addEventListener("change", (e) => {
    decisions().model = e.target.value.trim();
    persist();
  });
  $("#dec-base-url").addEventListener("change", (e) => {
    decisions().baseUrl = e.target.value.trim();
    persist();
    renderDecisions(); // the "your key goes here" warning depends on this field
  });
  $("#dec-sensitivity").addEventListener("change", (e) => {
    decisions().sensitivity = e.target.value;
    persist();
  });
  for (const [sel, key] of DECISION_FEATURES) {
    $(sel).addEventListener("change", (e) => {
      decisions().features[key] = e.target.checked;
      persist();
    });
  }
  $("#dec-test").addEventListener("click", () => runDecisionTest($("#dec-test"), $("#dec-test-status")));
}

function renderDecisions() {
  const d = decisions();
  const source = d.source === "typesafe" ? "typesafe" : "openrouter";
  $("#dec-enabled").checked = !!d.enabled;
  const sourceRadio = document.querySelector(`input[name="dec-source"][value="${source}"]`);
  if (sourceRadio) sourceRadio.checked = true;

  // Only a provider that really points at openrouter.ai can lend its key.
  const orProviders = (config.providers || []).filter((p) => isOpenRouterUrl(p.baseUrl));
  const select = $("#dec-provider");
  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = orProviders.length ? "Pick a provider…" : "No OpenRouter providers";
  select.appendChild(blank);
  for (const p of orProviders) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name + (p.apiKey ? "" : " (no key yet)");
    select.appendChild(opt);
  }
  select.value = orProviders.some((p) => p.id === d.providerId) ? d.providerId : "";
  $("#dec-provider-field").hidden = source !== "openrouter";
  $("#dec-provider-hint").hidden = orProviders.length > 0;

  $("#dec-key-field").hidden = source !== "typesafe";
  $("#dec-key").value = d.apiKey || "";
  $("#dec-model").value = d.model || "";
  $("#dec-model").placeholder = DEFAULT_DECISION_MODELS[source];
  $("#dec-base-url").value = d.baseUrl || "";
  $("#dec-base-url").placeholder = source === "typesafe" ? TYPESAFE_DECISIONS_URL : OPENROUTER_DECISIONS_URL;
  // An override is the one way a key reaches a host we didn't check — name the
  // key that would travel so a "just paste this proxy URL" has to say it out loud.
  const baseUrlHint = $("#dec-base-url-hint");
  baseUrlHint.classList.toggle("warn", !!d.baseUrl);
  // …and say it out loud when the override is plain http: the key would travel
  // unencrypted, which is only ever reasonable for a local proxy.
  const plainHttp = /^http:\/\//i.test((d.baseUrl || "").trim());
  baseUrlHint.textContent = d.baseUrl
    ? (source === "typesafe"
        ? "Your TypeSafe key will be sent to this URL."
        : "Your OpenRouter provider's key will be sent to this URL.") +
      (plainHttp ? " This URL is plain http, so the key is not encrypted in transit." : "")
    : "Leave blank to use the standard endpoint for the key source above.";
  $("#dec-sensitivity").value = d.sensitivity || DEFAULT_CONFIG.decisions.sensitivity;

  // No usable key source = nothing to switch on.
  const resolvable = !!resolveSource(withDecisionsEnabled());
  for (const [sel, key] of DECISION_FEATURES) {
    const box = $(sel);
    box.checked = !!d.features[key];
    box.disabled = !resolvable;
  }
  $("#dec-features-hint").hidden = resolvable;
}

// The Test button and the "is a source usable?" check both ignore the master
// switch — you can verify a key before turning anything on.
function withDecisionsEnabled() {
  return { ...config, decisions: { ...decisions(), enabled: true } };
}

async function runDecisionTest(btn, statusEl) {
  const src = resolveSource(withDecisionsEnabled());
  statusEl.hidden = false;
  if (!src) {
    statusEl.innerHTML = `<span class="test-line fail">Pick a key source above and make sure its key is filled in.</span>`;
    return;
  }
  btn.disabled = true;
  statusEl.innerHTML = `<span class="test-line muted">Asking <code>${escapeHtml(src.model)}</code> two questions with known answers…</span>`;
  try {
    const r = await testDecisions(src);
    const icon = { ok: "✓", warn: "⚠", fail: "✗" };
    const line = (label, res) =>
      `<span class="test-line ${res.status}">${icon[res.status]} <strong>${label}</strong> — ${escapeHtml(res.detail)}</span>`;
    let verdict = "";
    if (r.auth.status !== "ok") {
      verdict = `<span class="test-line fail">No answer from the endpoint — every check would fall back to the built-in ones.</span>`;
    } else if (r.noul.status === "ok" && r.choice.status === "ok") {
      verdict = `<span class="test-line ${r.latencyMs.status === "ok" ? "ok" : "warn"}">Smart checks work with this key and model.${
        r.latencyMs.status === "ok" ? "" : " Latency is above the budget for checks before an action, so those may be slow."
      }</span>`;
    } else {
      verdict = `<span class="test-line warn">The endpoint answered, but not with the expected answers — check the model id.</span>`;
    }
    statusEl.innerHTML = [
      line("Auth", r.auth),
      line("Yes-no", r.noul),
      line("Choice", r.choice),
      line("Latency", r.latencyMs),
      verdict,
    ].join("");
  } catch (e) {
    statusEl.innerHTML = `<span class="test-line fail">Test failed: ${escapeHtml(String(e.message || e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Site permissions
// -------------------------------------------------------------------------
function renderPermissions() {
  const entries = Object.entries(config.sitePermissions || {});
  permList.innerHTML = "";
  noPerms.hidden = entries.length > 0;
  for (const [origin, state] of entries) {
    const row = document.createElement("div");
    row.className = "perm-item";
    row.innerHTML = `
      <span class="origin">${escapeHtml(origin)}</span>
      <span class="perm-state ${state}">${state === "allow" ? "allowed" : "blocked"}</span>
      <button class="link-btn">Remove</button>`;
    row.querySelector("button").addEventListener("click", () => {
      delete config.sitePermissions[origin];
      persist();
      renderPermissions();
    });
    permList.appendChild(row);
  }
}

// -------------------------------------------------------------------------
// Saved prompts
// -------------------------------------------------------------------------
function renderPrompts() {
  const list = $("#prompt-list");
  list.innerHTML = "";
  $("#no-prompts").hidden = (config.prompts || []).length > 0;
  for (const p of config.prompts) {
    const row = document.createElement("div");
    row.className = "prompt-item";
    row.innerHTML = `
      <div class="prompt-head">
        <span class="prompt-cmd-prefix">/</span>
        <input class="prompt-cmd" placeholder="command" />
        <button class="link-btn">Remove</button>
      </div>
      <textarea class="prompt-body" placeholder="The prompt text this command inserts…"></textarea>`;
    const cmd = row.querySelector(".prompt-cmd");
    const body = row.querySelector(".prompt-body");
    cmd.value = p.command || "";
    body.value = p.text || "";
    cmd.addEventListener("change", () => {
      p.command = cmd.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      cmd.value = p.command;
      persist();
    });
    body.addEventListener("change", () => {
      p.text = body.value;
      persist();
    });
    row.querySelector(".link-btn").addEventListener("click", () => {
      config.prompts = config.prompts.filter((x) => x.id !== p.id);
      persist();
      renderPrompts();
    });
    list.appendChild(row);
  }
}

function addPrompt() {
  config.prompts = config.prompts || [];
  config.prompts.push({ id: crypto.randomUUID(), command: "", text: "" });
  persist();
  renderPrompts();
}

// -------------------------------------------------------------------------
// Scheduled tasks
// -------------------------------------------------------------------------
function renderScheduled() {
  const list = $("#sched-list");
  list.innerHTML = "";
  $("#no-sched").hidden = (config.scheduledTasks || []).length > 0;
  for (const t of config.scheduledTasks) {
    const row = document.createElement("div");
    row.className = "sched-item";
    row.innerHTML = `
      <div class="field"><label>Name</label><input class="s-name" placeholder="e.g. Morning news digest" /></div>
      <div class="field"><label>Prompt</label><textarea class="s-prompt" placeholder="What should it do each time?"></textarea></div>
      <div class="field"><label>Start URL (optional)</label><input class="s-url" placeholder="leave blank to use the current tab" /></div>
      <div class="grid2">
        <div>
          <label>Run every … minutes</label>
          <input type="number" class="s-interval" min="1" />
          <div class="interval-hint">60 = hourly · 360 = every 6h · 1440 = daily · 10080 = weekly</div>
        </div>
        <div><label>&nbsp;</label><label class="enabled-label"><input type="checkbox" class="s-enabled" /> Enabled</label></div>
      </div>
      <div class="sched-actions">
        <button class="btn small s-run">Run now</button>
        <button class="link-btn s-del">Remove</button>
      </div>`;
    const q = (sel) => row.querySelector(sel);
    q(".s-name").value = t.name || "";
    q(".s-prompt").value = t.prompt || "";
    q(".s-url").value = t.url || "";
    q(".s-interval").value = t.intervalMinutes || 1440;
    q(".s-enabled").checked = !!t.enabled;
    q(".s-name").addEventListener("change", (e) => { t.name = e.target.value; persist(); });
    q(".s-prompt").addEventListener("change", (e) => { t.prompt = e.target.value; persist(); });
    q(".s-url").addEventListener("change", (e) => { t.url = e.target.value.trim(); persist(); });
    q(".s-interval").addEventListener("change", (e) => { t.intervalMinutes = clampInt(e.target.value, 1, 100000, 1440); persist(); });
    q(".s-enabled").addEventListener("change", (e) => { t.enabled = e.target.checked; persist(); });
    q(".s-run").addEventListener("click", () => runSchedNow(t, q(".s-run")));
    q(".s-del").addEventListener("click", () => {
      config.scheduledTasks = config.scheduledTasks.filter((x) => x.id !== t.id);
      persist();
      renderScheduled();
    });
    list.appendChild(row);
  }
}

function addSched() {
  config.scheduledTasks = config.scheduledTasks || [];
  config.scheduledTasks.push({ id: crypto.randomUUID(), name: "", prompt: "", url: "", intervalMinutes: 1440, enabled: false });
  persist();
  renderScheduled();
}

async function runSchedNow(task, btn) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Running…";
  try {
    await chrome.runtime.sendMessage({ type: MSG.RUN_SCHEDULED, id: task.id });
    btn.textContent = "Started ✓";
  } catch {
    btn.textContent = "Failed";
  }
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 2500);
}

// -------------------------------------------------------------------------
// Workflows
// -------------------------------------------------------------------------
function renderWorkflows() {
  const list = $("#wf-list");
  list.innerHTML = "";
  $("#no-wf").hidden = (config.workflows || []).length > 0;
  for (const w of config.workflows) {
    const row = document.createElement("div");
    row.className = "prompt-item";
    const steps = (w.steps || []).map((s) => `<li>${escapeHtml(s.description || String(s))}</li>`).join("");
    row.innerHTML = `
      <div class="prompt-head">
        <input class="prompt-cmd wf-name" placeholder="Workflow name" />
        <button class="link-btn">Remove</button>
      </div>
      ${w.startUrl ? `<div class="interval-hint">Starts at ${escapeHtml(w.startUrl)}</div>` : ""}
      <ol class="wf-steps">${steps}</ol>`;
    const nameInput = row.querySelector(".wf-name");
    nameInput.value = w.name || "";
    nameInput.addEventListener("change", () => {
      w.name = nameInput.value.trim() || "Untitled workflow";
      nameInput.value = w.name;
      persist();
    });
    row.querySelector(".link-btn").addEventListener("click", () => {
      config.workflows = config.workflows.filter((x) => x.id !== w.id);
      persist();
      renderWorkflows();
    });
    list.appendChild(row);
  }
}

// -------------------------------------------------------------------------
// MCP tool servers
// -------------------------------------------------------------------------
function renderMcp() {
  const list = $("#mcp-list");
  list.innerHTML = "";
  $("#no-mcp").hidden = (config.mcpServers || []).length > 0;
  for (const m of config.mcpServers) {
    const row = document.createElement("div");
    row.className = "sched-item";
    row.innerHTML = `
      <div class="field"><label>Name</label><input class="m-name" placeholder="e.g. github" /></div>
      <div class="field"><label>Server URL</label><input class="m-url" placeholder="https://…/mcp" /></div>
      <div class="field"><label>Auth token (optional)</label><input type="password" class="m-token" placeholder="Bearer token, if the server needs one" autocomplete="off" /></div>
      <div class="sched-actions">
        <label class="enabled-label"><input type="checkbox" class="m-enabled" /> Enabled</label>
        <button class="btn small m-test">Test</button>
        <button class="link-btn m-del">Remove</button>
      </div>
      <p class="interval-hint m-status"></p>`;
    const q = (sel) => row.querySelector(sel);
    q(".m-name").value = m.name || "";
    q(".m-url").value = m.url || "";
    q(".m-token").value = m.authToken || "";
    q(".m-enabled").checked = !!m.enabled;
    q(".m-name").addEventListener("change", (e) => { m.name = e.target.value.trim(); persist(); });
    q(".m-url").addEventListener("change", (e) => { m.url = e.target.value.trim(); persist(); });
    q(".m-token").addEventListener("change", (e) => { m.authToken = e.target.value.trim(); persist(); });
    q(".m-enabled").addEventListener("change", (e) => { m.enabled = e.target.checked; persist(); });
    q(".m-del").addEventListener("click", () => {
      config.mcpServers = config.mcpServers.filter((x) => x.id !== m.id);
      persist();
      renderMcp();
    });
    q(".m-test").addEventListener("click", () => testMcp(m, q(".m-status"), q(".m-test")));
    list.appendChild(row);
  }
}

function addMcp() {
  config.mcpServers = config.mcpServers || [];
  config.mcpServers.push({ id: crypto.randomUUID(), name: "", url: "", authToken: "", enabled: true });
  persist();
  renderMcp();
}

async function testMcp(server, statusEl, btn) {
  if (!server.url) {
    statusEl.textContent = "Enter a server URL first.";
    statusEl.style.color = "var(--danger)";
    return;
  }
  btn.disabled = true;
  statusEl.style.color = "var(--muted)";
  statusEl.textContent = "Connecting…";
  try {
    const session = await connectServer(server);
    const tools = await listTools(server, session);
    const names = tools.map((t) => t.name).slice(0, 8).join(", ");
    statusEl.textContent = `Connected — ${tools.length} tool${tools.length === 1 ? "" : "s"}${names ? ": " + names : ""}.`;
    statusEl.style.color = "var(--good, #157a4d)";
  } catch (e) {
    statusEl.textContent = "Failed: " + (e.message || e);
    statusEl.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
let toastTimer = null;
let selfWrites = 0; // storage.onChanged events caused by our own persist()
async function persist() {
  selfWrites++;
  try {
    await saveConfig(config);
  } catch (e) {
    selfWrites--; // the write never happened, so no onChanged will fire for it
    throw e;
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1200);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
