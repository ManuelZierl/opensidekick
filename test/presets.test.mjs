// Suggested models per preset, the models-page link, and presetFor(): which
// preset a provider came from (by presetId, else by the exact base-URL host).
import { PROVIDER_PRESETS, MODELS_PAGE_URL } from "../src/common/constants.js";
import { presetFor } from "../src/common/presets.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
};

const KINDS = ["closed", "open", "budget", "light"];
const byId = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));

// ---- Shape ----
for (const p of PROVIDER_PRESETS) {
  const s = p.suggestions;
  assert(Array.isArray(s) && s.length <= 2, `${p.id}: suggestions is an array of at most 2 (got ${s && s.length})`);
  for (const x of s || []) {
    assert(
      ["model", "label", "kind", "note"].every((k) => typeof x[k] === "string" && x[k].length > 0),
      `${p.id}: suggestion ${x.model} has model, label, kind and note`,
    );
    assert(KINDS.includes(x.kind), `${p.id}: suggestion ${x.model} kind "${x.kind}" is one of ${KINDS.join("/")}`);
  }
}
assert(byId.custom.suggestions.length === 0, "custom: no suggestions");

// ---- The exact ids as of 2026-10-10 (Ollama: 2026-10-13) ----
const EXPECTED = {
  openrouter: ["anthropic/claude-sonnet-5.5", "qwen/qwen3-vl-235b-a22b-instruct"],
  venice: ["claude-sonnet-5-5", "qwen3-vl-235b-a22b"],
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  openai: ["gpt-5.6-terra", "gpt-5.6-luna"],
  google: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
  groq: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  ollama: ["qwen3-vl:30b-a3b-instruct", "qwen3-vl:8b-instruct"],
  lmstudio: ["qwen/qwen3-vl-8b", "mistralai/mistral-small-3.2"],
};
for (const [id, models] of Object.entries(EXPECTED)) {
  const got = (byId[id]?.suggestions || []).map((x) => x.model);
  assert(JSON.stringify(got) === JSON.stringify(models), `${id}: suggests ${models.join(", ")} (got ${got.join(", ")})`);
}

// ---- Ollama: never a bare qwen3-vl tag ----
// Those are the thinking builds, which spend a small budget thinking and never
// answer or call a tool (ollama/ollama#16945).
for (const m of [byId.ollama.defaultModel, ...byId.ollama.suggestions.map((x) => x.model)]) {
  if (!m.startsWith("qwen3-vl")) continue;
  assert(m.includes("-instruct"), `ollama: ${m} is an instruct tag, not a thinking build`);
}

// ---- Default model: the first suggestion (Ollama: the light pick) ----
for (const p of PROVIDER_PRESETS) {
  if (!p.suggestions.length) continue;
  // LM Studio stays empty: its ids depend on what the user downloaded, and a
  // pre-filled id would fail the auto-test the moment the preset is added.
  const want = p.id === "lmstudio" ? "" : p.id === "ollama" ? p.suggestions.find((x) => x.kind === "light")?.model : p.suggestions[0].model;
  assert(p.defaultModel === want, `${p.id}: defaultModel is ${JSON.stringify(want)} (got ${JSON.stringify(p.defaultModel)})`);
}
assert(byId.custom.defaultModel === "", `custom: no default model (got ${JSON.stringify(byId.custom.defaultModel)})`);

assert(MODELS_PAGE_URL === "https://opensidekick.app/models/", `MODELS_PAGE_URL is the models page (got ${MODELS_PAGE_URL})`);

// ---- presetFor ----
const idOf = (provider) => presetFor(provider)?.id ?? null;
assert(idOf({ presetId: "venice", baseUrl: "https://openrouter.ai/api/v1" }) === "venice", "presetFor: presetId wins over the base URL");
assert(idOf({ presetId: "custom", baseUrl: "https://example.com/v1" }) === "custom", "presetFor: a custom provider resolves to the custom preset by id");
assert(idOf({ presetId: "gone", baseUrl: "https://openrouter.ai/api/v1" }) === "openrouter", "presetFor: an unknown presetId falls back to the host");
assert(idOf({ baseUrl: "https://openrouter.ai/api/v1" }) === "openrouter", "presetFor: openrouter.ai → openrouter");
assert(idOf({ baseUrl: "https://api.venice.ai/api/v1" }) === "venice", "presetFor: api.venice.ai → venice");
assert(idOf({ baseUrl: "https://API.Venice.ai/api/v1" }) === "venice", "presetFor: the host match ignores case");
assert(idOf({ baseUrl: "https://api.venice.ai.evil.com/api/v1" }) === null, "presetFor: api.venice.ai.evil.com → null");
assert(idOf({ baseUrl: "https://evilopenrouter.ai/api/v1" }) === null, "presetFor: a lookalike prefix → null");
assert(idOf({ baseUrl: "https://evil.com/openrouter.ai/api/v1" }) === null, "presetFor: the preset host in the path → null");
assert(idOf({ baseUrl: "http://localhost:11434/v1" }) === "ollama", "presetFor: localhost:11434 → ollama");
assert(idOf({ baseUrl: "http://localhost:1234/v1" }) === "lmstudio", "presetFor: localhost:1234 → lmstudio");
assert(idOf({ baseUrl: "http://127.0.0.1:11434/v1" }) === "ollama", "presetFor: 127.0.0.1:11434 → ollama");
assert(idOf({ baseUrl: "http://[::1]:1234/v1" }) === "lmstudio", "presetFor: [::1]:1234 → lmstudio");
assert(idOf({ baseUrl: "http://127.0.0.1:1234" }) === "lmstudio", "presetFor: 127.0.0.1:1234 with no path → lmstudio");
assert(idOf({ baseUrl: "https://127.0.0.1.evil.com:11434" }) === null, "presetFor: 127.0.0.1.evil.com:11434 → null");
assert(idOf({ baseUrl: "http://127.0.0.1:8080/v1" }) === null, "presetFor: another loopback port → null");
assert(idOf({ baseUrl: "http://localhost:8080/v1" }) === null, "presetFor: another localhost port → null");
assert(idOf({ baseUrl: "" }) === null, "presetFor: no base URL → null");
assert(idOf({ baseUrl: "not a url" }) === null, "presetFor: an unparseable base URL → null");
assert(idOf(null) === null, "presetFor: no provider → null");
