// Venice AI: preset shape, the api.venice.ai host check, and the two
// Venice-only request tweaks (venice_parameters + the text-only model filter).
import { PROVIDER_PRESETS, PROVIDER_TYPES } from "../src/common/constants.js";
import { callModel, listModels, isVeniceUrl } from "../src/background/providers.js";

function fakeSse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
};

// Records what the last fetch() was called with, so each test can inspect the
// exact URL, headers, and body the provider layer produced.
let lastCall = null;
function mockFetch(respond) {
  globalThis.fetch = async (url, init = {}) => {
    lastCall = { url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    return respond();
  };
}

// ---- (a) the preset ----
const venicePresets = PROVIDER_PRESETS.filter((p) => p.id === "venice");
assert(venicePresets.length === 1, `exactly one "venice" preset (got ${venicePresets.length})`);
const venice = venicePresets[0] || {};
assert(venice.name === "Venice AI", `preset name "Venice AI" (got ${JSON.stringify(venice.name)})`);
assert(venice.type === "openai", `preset type "openai" (got ${JSON.stringify(venice.type)})`);
assert(venice.baseUrl === "https://api.venice.ai/api/v1", `preset baseUrl (got ${JSON.stringify(venice.baseUrl)})`);
assert(venice.defaultModel === "qwen-3-8-27b", `preset defaultModel qwen-3-8-27b (got ${JSON.stringify(venice.defaultModel)})`);
assert(venice.keyUrl === "https://venice.ai/settings/api", `preset keyUrl (got ${JSON.stringify(venice.keyUrl)})`);

const ids = PROVIDER_PRESETS.map((p) => p.id);
const vi = ids.indexOf("venice");
assert(ids[vi - 1] === "groq", `preset sits right after "groq" (got ${ids[vi - 1]})`);
assert(ids[vi + 1] === "ollama", `preset sits right before "ollama" (got ${ids[vi + 1]})`);

// ---- (b) preset hygiene, all presets ----
assert(new Set(ids).size === ids.length, `preset ids are unique (${ids.join(", ")})`);
const REQUIRED = ["id", "name", "type", "baseUrl", "defaultModel", "keyUrl", "hint"];
const missing = PROVIDER_PRESETS.filter((p) => REQUIRED.some((k) => !(k in p))).map((p) => p.id);
assert(missing.length === 0, `every preset has ${REQUIRED.join("/")} (missing in: ${missing.join(", ") || "none"})`);
const badType = PROVIDER_PRESETS.filter((p) => !PROVIDER_TYPES.includes(p.type)).map((p) => p.id);
assert(badType.length === 0, `every preset type is a known PROVIDER_TYPE (bad: ${badType.join(", ") || "none"})`);
const trailing = PROVIDER_PRESETS.filter((p) => /\/$/.test(p.baseUrl)).map((p) => p.id);
assert(trailing.length === 0, `no preset baseUrl has a trailing slash (bad: ${trailing.join(", ") || "none"})`);
const badUrl = PROVIDER_PRESETS.filter((p) =>
  [p.baseUrl, p.keyUrl].some((u) => u && !/^https?:\/\//.test(u)),
).map((p) => p.id);
assert(badUrl.length === 0, `non-empty baseUrl/keyUrl are http(s) URLs (bad: ${badUrl.join(", ") || "none"})`);

// ---- (c) isVeniceUrl ----
for (const url of [
  "https://api.venice.ai/api/v1",
  "https://api.venice.ai/api/v1/",
  "HTTPS://API.VENICE.AI/api/v1",
  "https://api.venice.ai./api/v1", // fully-qualified host, same server
  "http://api.venice.ai/api/v1",
]) {
  assert(isVeniceUrl(url) === true, `isVeniceUrl true for ${url}`);
}
for (const url of ["https://openrouter.ai/api/v1", "https://api.venice.ai.evil.com/api/v1", "https://venice.ai/api/v1", "ftp://api.venice.ai/api/v1", "", undefined, "not a url"]) {
  assert(isVeniceUrl(url) === false, `isVeniceUrl false for ${JSON.stringify(url)}`);
}

// ---- (d) callModel against Venice ----
const sse = [
  `data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"there"}}]}\n\n`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_page","arguments":"{\\"full\\":true}"}}]}}]}\n\n`,
  `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
  `data: [DONE]\n\n`,
];
const VENICE_PROVIDER = { type: "openai", baseUrl: "https://api.venice.ai/api/v1", apiKey: "k" };
const TOOLS = [{ name: "read_page", description: "Read the page.", parameters: { type: "object", properties: {} } }];

mockFetch(() => fakeSse(sse));
const r = await callModel(VENICE_PROVIDER, {
  model: "qwen-3-8-27b",
  messages: [{ role: "user", content: "hi" }],
  tools: TOOLS,
});
assert(lastCall.url === "https://api.venice.ai/api/v1/chat/completions", `venice chat URL (got ${lastCall.url})`);
const auth = Object.entries(lastCall.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
assert(auth === "Bearer k", `venice Authorization header (got ${auth})`);
// Structural, not JSON.stringify: key order in the body must not matter.
const vp = lastCall.body.venice_parameters || {};
assert(
  Object.keys(vp).length === 2 && vp.include_venice_system_prompt === false && vp.strip_thinking_response === true,
  `venice_parameters sent (got ${JSON.stringify(lastCall.body.venice_parameters)})`,
);
assert(lastCall.body.model === "qwen-3-8-27b", `body.model (got ${lastCall.body.model})`);
assert(lastCall.body.stream === true, `body.stream true (got ${lastCall.body.stream})`);
assert(
  Array.isArray(lastCall.body.messages) && lastCall.body.messages[0]?.content === "hi",
  `body.messages carries the user turn (got ${JSON.stringify(lastCall.body.messages)})`,
);
assert(
  lastCall.body.tools?.length === 1 && lastCall.body.tools[0].function.name === "read_page",
  `body.tools carries the tool (got ${JSON.stringify(lastCall.body.tools)})`,
);
assert(r.content === "Hi there", `venice content == "Hi there" (got "${r.content}")`);
assert(r.toolCalls.length === 1 && r.toolCalls[0].name === "read_page", `venice tool call parsed (got ${JSON.stringify(r.toolCalls)})`);
assert(JSON.stringify(r.toolCalls[0]?.args) === '{"full":true}', `venice tool args (got ${JSON.stringify(r.toolCalls[0]?.args)})`);

// ---- (e) callModel against a non-Venice provider ----
mockFetch(() => fakeSse(sse));
await callModel(
  { type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
  { model: "m", messages: [{ role: "user", content: "hi" }], tools: TOOLS },
);
assert(!("venice_parameters" in lastCall.body), `no venice_parameters for other providers (body keys: ${Object.keys(lastCall.body).join(", ")})`);

// ---- (f) listModels ----
// Shaped like Venice's real catalog: ids out of order, each with model_spec.
const catalog = {
  object: "list",
  type: "text",
  data: [
    { id: "qwen-3-8-27b", type: "text", model_spec: { capabilities: { supportsFunctionCalling: true, supportsVision: true }, traits: ["default_vision"] } },
    { id: "kimi-k3", type: "text", model_spec: { capabilities: { supportsFunctionCalling: true, supportsVision: false }, traits: ["default_reasoning"] } },
    { id: "gemini-3-6-flash", type: "text", model_spec: { capabilities: { supportsFunctionCalling: true, supportsVision: true }, traits: [] } },
  ],
};
const jsonOk = () => new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });

mockFetch(jsonOk);
const models = await listModels(VENICE_PROVIDER);
assert(lastCall.url === "https://api.venice.ai/api/v1/models?type=text", `venice models URL is text-filtered (got ${lastCall.url})`);
assert(
  JSON.stringify(models) === JSON.stringify(["gemini-3-6-flash", "kimi-k3", "qwen-3-8-27b"]),
  `venice model ids returned sorted (got ${JSON.stringify(models)})`,
);

mockFetch(jsonOk);
await listModels({ type: "openai", baseUrl: "https://api.venice.ai/api/v1/", apiKey: "k" });
assert(lastCall.url === "https://api.venice.ai/api/v1/models?type=text", `trailing slash yields no double slash (got ${lastCall.url})`);

mockFetch(jsonOk);
await listModels({ type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" });
assert(lastCall.url === "https://openrouter.ai/api/v1/models", `non-venice models URL has no query string (got ${lastCall.url})`);

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
