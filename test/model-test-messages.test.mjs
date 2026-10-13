// What the Settings model test says for a thinking build (instructTagFor,
// thinkingVerdict) and for a local server that blocks the extension (corsHint),
// plus the loopback check options.js shares with them (isLocalBaseUrl).
import { instructTagFor, thinkingVerdict, corsHint, isLocalBaseUrl } from "../src/common/model-test-messages.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
};

const README = "https://github.com/esterhuizen/opensidekick#using-a-local-model-ollama-lm-studio";

// ---- instructTagFor ----
const TAGS = {
  "qwen3-vl": "qwen3-vl:8b-instruct",
  "qwen3-vl:latest": "qwen3-vl:8b-instruct",
  "qwen3-vl:8b": "qwen3-vl:8b-instruct",
  "qwen3-vl:2b": "qwen3-vl:2b-instruct",
  "qwen3-vl:4b": "qwen3-vl:4b-instruct",
  "qwen3-vl:30b": "qwen3-vl:30b-a3b-instruct",
  "qwen3-vl:30b-a3b": "qwen3-vl:30b-a3b-instruct",
  "qwen3-vl:32b": "qwen3-vl:32b-instruct",
  "qwen3-vl:235b": "qwen3-vl:235b-a22b-instruct",
  "qwen3-vl:235b-a22b": "qwen3-vl:235b-a22b-instruct",
};
for (const [model, want] of Object.entries(TAGS)) {
  assert(instructTagFor(model) === want, `instructTagFor(${model}) → ${want} (got ${instructTagFor(model)})`);
}
for (const model of [
  "qwen3-vl:8b-instruct",
  "qwen3-vl:30b-a3b-instruct",
  "qwen3-vl:8b-thinking",
  "qwen3-vl:30b-a3b-thinking",
  "qwen/qwen3-vl-8b",
  "llama3.1",
  "constructor",
  "",
  undefined,
]) {
  assert(instructTagFor(model) === null, `instructTagFor(${JSON.stringify(model)}) → null (got ${instructTagFor(model)})`);
}

// ---- thinkingVerdict ----
const BASE = "This model thinks before it answers, and it used the whole test budget on thinking.";
const OLLAMA = { presetId: "ollama", baseUrl: "http://localhost:11434/v1" };
const LMSTUDIO = { presetId: "lmstudio", baseUrl: "http://localhost:1234/v1" };
const PICK = `${BASE} Pick a non-thinking (instruct) build of this model, or a different model.`;
const USE = (tag) => `${BASE} Use the instruct build instead: ${tag} (ollama pull ${tag}).`;

assert(thinkingVerdict(OLLAMA, "qwen3-vl:8b") === USE("qwen3-vl:8b-instruct"), "thinkingVerdict: ollama preset + qwen3-vl:8b names the instruct tag");
assert(thinkingVerdict(OLLAMA, "qwen3-vl:30b") === USE("qwen3-vl:30b-a3b-instruct"), "thinkingVerdict: ollama preset + qwen3-vl:30b names the 30b-a3b instruct tag");
assert(
  thinkingVerdict({ presetId: "custom", baseUrl: "http://127.0.0.1:11434/v1" }, "qwen3-vl") === USE("qwen3-vl:8b-instruct"),
  "thinkingVerdict: loopback port 11434 counts as Ollama",
);
assert(thinkingVerdict({ baseUrl: "http://[::1]:11434/v1" }, "qwen3-vl:latest") === USE("qwen3-vl:8b-instruct"), "thinkingVerdict: [::1]:11434 counts as Ollama");
assert(thinkingVerdict(OLLAMA, "deepseek-r1:8b") === PICK, "thinkingVerdict: ollama + a model with no known instruct tag → generic advice");
assert(thinkingVerdict(LMSTUDIO, "qwen3-vl:8b") === PICK, "thinkingVerdict: not Ollama → generic advice, no ollama pull");
assert(thinkingVerdict({ presetId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "qwen3-vl:8b") === PICK, "thinkingVerdict: hosted provider → generic advice");
assert(thinkingVerdict({ baseUrl: "http://localhost:8080/v1" }, "qwen3-vl:8b") === PICK, "thinkingVerdict: another loopback port → generic advice");
assert(!/—/.test(thinkingVerdict(OLLAMA, "qwen3-vl:8b") + PICK), "thinkingVerdict: no em dashes");

// ---- corsHint ----
const ollamaHint = corsHint(OLLAMA, 403);
assert(
  ollamaHint?.text ===
    "Ollama blocked the extension (HTTP 403). Set OLLAMA_ORIGINS=chrome-extension://* where Ollama runs, restart Ollama, then press Test.",
  `corsHint: ollama 403 names OLLAMA_ORIGINS (got ${ollamaHint?.text})`,
);
assert(ollamaHint?.readmeUrl === README, "corsHint: links the README local-model section");
assert(corsHint(OLLAMA, 401) === null, "corsHint: ollama 401 (an auth problem, not an origin block) → null");
assert(/^Ollama blocked/.test(corsHint({ presetId: "custom", baseUrl: "http://127.0.0.1:11434/v1" }, 403)?.text || ""), "corsHint: loopback port 11434 counts as Ollama");

const lmHint = corsHint(LMSTUDIO, 403);
assert(
  lmHint?.text ===
    "LM Studio blocked the extension (HTTP 403). Switch on Enable CORS in the server settings, or start it with: lms server start --cors. Then press Test.",
  `corsHint: lmstudio 403 names Enable CORS (got ${lmHint?.text})`,
);
assert(lmHint?.readmeUrl === README, "corsHint: lmstudio links the README too");
assert(/^LM Studio blocked/.test(corsHint({ baseUrl: "http://localhost:1234/v1" }, 403)?.text || ""), "corsHint: loopback port 1234 counts as LM Studio");

const otherHint = corsHint({ presetId: "custom", baseUrl: "http://localhost:8080/v1" }, 403);
assert(
  otherHint?.text === "Your local server blocked the extension (HTTP 403). Allow requests from chrome-extension:// origins (CORS), then press Test.",
  `corsHint: other loopback server gets the generic CORS hint (got ${otherHint?.text})`,
);
assert(otherHint?.readmeUrl === README, "corsHint: other loopback links the README too");

assert(corsHint({ presetId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, 403) === null, "corsHint: a hosted provider's 403 → null");
assert(corsHint({ presetId: "ollama", baseUrl: "http://192.168.1.20:11434/v1" }, 403) === null, "corsHint: Ollama on another machine → null");
assert(corsHint(OLLAMA, 404) === null, "corsHint: a 404 → null");
assert(corsHint(OLLAMA, 500) === null, "corsHint: a 500 → null");
assert(corsHint(OLLAMA, undefined) === null, "corsHint: no status (network error) → null");
assert(corsHint(null, 403) === null, "corsHint: no provider → null");
assert(![ollamaHint, lmHint, otherHint].some((h) => /—/.test(h.text)), "corsHint: no em dashes");

// ---- isLocalBaseUrl ----
for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234", "http://[::1]:1234/v1", "http://LOCALHOST./v1", "http://ollama.localhost/v1"]) {
  assert(isLocalBaseUrl(url) === true, `isLocalBaseUrl(${url}) → true`);
}
for (const url of ["https://openrouter.ai/api/v1", "http://127.0.0.1.evil.com/v1", "http://192.168.1.20:11434/v1", "", "not a url", undefined]) {
  assert(isLocalBaseUrl(url) === false, `isLocalBaseUrl(${JSON.stringify(url)}) → false`);
}

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
