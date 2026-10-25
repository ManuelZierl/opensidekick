// Exercises the real callModel() streaming/parsing paths with a mocked fetch.
import { callModel, listModels } from "../src/background/providers.js";

function fakeResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
};

// ---- OpenAI ----
const openaiEvents = [
  `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"world"}}]}\n\n`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_page","arguments":""}}]}}]}\n\n`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
  `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
  `data: [DONE]\n\n`,
];
// Split into odd byte boundaries to test buffering across chunks.
const joined = openaiEvents.join("");
const twoChunks = [joined.slice(0, 137), joined.slice(137)];

globalThis.fetch = async () => fakeResponse(twoChunks);
let deltas = "";
let r = await callModel(
  { type: "openai", baseUrl: "https://x/v1", apiKey: "k" },
  { model: "m", messages: [{ role: "user", content: "hi" }], tools: [], onDelta: (t) => (deltas += t) },
);
assert(r.content === "Hello world", `openai content == "Hello world" (got "${r.content}")`);
assert(deltas === "Hello world", `openai onDelta streamed text (got "${deltas}")`);
assert(r.toolCalls.length === 1, `openai one tool call (got ${r.toolCalls.length})`);
assert(r.toolCalls[0]?.name === "read_page", `openai tool name read_page (got ${r.toolCalls[0]?.name})`);
assert(JSON.stringify(r.toolCalls[0]?.args) === "{}", `openai tool args {} (got ${JSON.stringify(r.toolCalls[0]?.args)})`);
assert(r.stopReason === "tool_use", `openai stopReason tool_use (got ${r.stopReason})`);
assert(r.reasoning === "", `openai reasoning is "" when the model sent none (got ${JSON.stringify(r.reasoning)})`);

// ---- OpenAI: a thinking model's reasoning stays out of content and onDelta ----
// Ollama sends it as delta.reasoning; vLLM, LM Studio and DeepSeek-style
// servers as delta.reasoning_content.
globalThis.fetch = async () =>
  fakeResponse([
    `data: {"choices":[{"delta":{"role":"assistant","reasoning":"Hmm, "}}]}\n\n`,
    `data: {"choices":[{"delta":{"reasoning":"the user "}}]}\n\n`,
    `data: {"choices":[{"delta":{"reasoning_content":"wants a word."}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"ready"}}]}\n\n`,
    `data: {"choices":[{"finish_reason":"stop"}]}\n\n`,
    `data: [DONE]\n\n`,
  ]);
let thinkDeltas = "";
const rt = await callModel(
  { type: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "" },
  { model: "m", messages: [{ role: "user", content: "hi" }], onDelta: (t) => (thinkDeltas += t) },
);
assert(rt.reasoning === "Hmm, the user wants a word.", `openai reasoning + reasoning_content accumulate into reasoning (got ${JSON.stringify(rt.reasoning)})`);
assert(rt.content === "ready", `openai content is unaffected by reasoning (got ${JSON.stringify(rt.content)})`);
assert(thinkDeltas === "ready", `openai onDelta never receives reasoning text (got ${JSON.stringify(thinkDeltas)})`);
assert(rt.stopReason === "stop", `openai stopReason stop (got ${rt.stopReason})`);

// ---- Anthropic ----
const anthropicEvents = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"click_element"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ref\\":"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];
// Also test CRLF line endings this time.
const anthChunks = [anthropicEvents.join("").replace(/\n/g, "\r\n")];
globalThis.fetch = async () => fakeResponse(anthChunks);
let deltas2 = "";
let r2 = await callModel(
  { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" },
  { model: "claude", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100, onDelta: (t) => (deltas2 += t) },
);
assert(r2.content === "Hi", `anthropic content == "Hi" (got "${r2.content}")`);
assert(deltas2 === "Hi", `anthropic onDelta streamed text (got "${deltas2}")`);
assert(r2.toolCalls.length === 1, `anthropic one tool call (got ${r2.toolCalls.length})`);
assert(r2.toolCalls[0]?.name === "click_element", `anthropic tool name click_element`);
assert(JSON.stringify(r2.toolCalls[0]?.args) === '{"ref":5}', `anthropic tool args {ref:5} (got ${JSON.stringify(r2.toolCalls[0]?.args)})`);
assert(r2.stopReason === "tool_use", `anthropic stopReason tool_use (got ${r2.stopReason})`);
assert(r2.reasoning === "", `anthropic reasoning is "" for shape parity (got ${JSON.stringify(r2.reasoning)})`);

// ---- listModels: a failed request carries the HTTP status ----
for (const type of ["openai", "anthropic"]) {
  globalThis.fetch = async () => new Response("", { status: 403 });
  let err = null;
  try {
    await listModels({ type, baseUrl: "http://localhost:11434/v1", apiKey: "" });
  } catch (e) {
    err = e;
  }
  assert(err && err.message === "Models request failed: 403", `${type} listModels keeps its message (got ${err && err.message})`);
  assert(err && err.status === 403, `${type} listModels sets err.status (got ${err && err.status})`);
}

// ---- Gemini thought signatures (issue #7) ----
{
  const sig = "CiQBjz1rX-signature==";
  const gEvents = [
    `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"g1","type":"function","function":{"name":"navigate","arguments":"{}"},"extra_content":{"google":{"thought_signature":"${sig}"}}}]}}]}\n\n`,
    `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const gp = { type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "k" };
  globalThis.fetch = async () => fakeResponse(gEvents);
  const g = await callModel(gp, { model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "go" }], maxTokens: 100 });
  const tc = g.toolCalls[0];
  assert(tc?.replay?.extra_content?.google?.thought_signature === sig, "gemini: thought_signature kept on the tool call");
  assert(tc?.replay?.origin === "https://generativelanguage.googleapis.com/v1beta/openai", `gemini: replay origin is the trimmed base URL (got ${tc?.replay?.origin})`);

  const convo = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: g.toolCalls },
    { role: "tool", toolCallId: "g1", content: "ok" },
  ];
  let sent = null;
  globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return fakeResponse([`data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n`, "data: [DONE]\n\n"]); };
  await callModel(gp, { model: "gemini-3.5-flash-lite", messages: convo, maxTokens: 100 });
  const back = sent.messages.find((m) => m.role === "assistant").tool_calls[0];
  assert(back.extra_content?.google?.thought_signature === sig, "gemini: thought_signature sent back on the next request");

  await callModel({ type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" }, { model: "gpt", messages: convo, maxTokens: 100 });
  const other = sent.messages.find((m) => m.role === "assistant").tool_calls[0];
  assert(!("extra_content" in other), "gemini: signature is not sent to a different server");
}

// ---- OpenRouter reasoning_details (Gemini via OpenRouter) ----
{
  const orEvents = [
    `data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Think ","index":0}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"more","index":0}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"ENC","index":1,"id":"tool_x"}],"tool_calls":[{"index":0,"id":"tool_x","function":{"name":"read_page","arguments":"{}"}}]}}]}\n\n`,
    `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const op = { type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
  globalThis.fetch = async () => fakeResponse(orEvents);
  const o = await callModel(op, { model: "google/gemini-3.5-flash-lite", messages: [{ role: "user", content: "go" }], maxTokens: 100 });
  const rd = o.replay?.reasoning_details;
  assert(Array.isArray(rd) && rd.length === 2, `openrouter: two reasoning details (got ${JSON.stringify(rd)})`);
  assert(rd?.[0]?.text === "Think more", "openrouter: text pieces with one index are joined");
  assert(rd?.[1]?.data === "ENC", "openrouter: encrypted detail kept");
  let sent = null;
  globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return fakeResponse(["data: [DONE]\n\n"]); };
  const convo = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: o.toolCalls, replay: o.replay }, { role: "tool", toolCallId: "tool_x", content: "ok" }];
  await callModel(op, { model: "google/gemini-3.5-flash-lite", messages: convo, maxTokens: 100 });
  assert(JSON.stringify(sent.messages.find((m) => m.role === "assistant").reasoning_details) === JSON.stringify(rd), "openrouter: reasoning_details sent back unchanged");
  await callModel({ type: "openai", baseUrl: "http://localhost:11434/v1" }, { model: "x", messages: convo, maxTokens: 100 });
  assert(!("reasoning_details" in sent.messages.find((m) => m.role === "assistant")), "openrouter: reasoning_details not sent to a different server");
  // A plain reply carries no replay field at all.
  globalThis.fetch = async () => fakeResponse([`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`, "data: [DONE]\n\n"]);
  const plain = await callModel(op, { model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10 });
  assert(!("replay" in plain), "plain reply: no replay field");
}

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
