// Integration test for the model capability probe (testModel). Spins up mock
// OpenAI-compatible servers that behave like: (a) a full tools+vision model,
// (b) a vision model with no tool-calling endpoint (the user's Qwen-VL case),
// (c) a text-only model that rejects images, a thinking model that spends the
// whole budget thinking (in a reasoning field or an inline <think> block), and
// a local server that refuses the extension with a bare 403 — and asserts the
// probe reports each correctly.

import http from "node:http";
import { testModel } from "../src/background/providers.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "ok  : " : "FAIL: ") + m);
  if (!c) fail = 1;
};

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write("data: " + JSON.stringify(c) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}
const say = (text) => [
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { content: text } }] },
  { choices: [{ finish_reason: "stop" }] },
];
const callEcho = () => [
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"word":"ok"}' } }] } }] },
  { choices: [{ finish_reason: "tool_calls" }] },
];
const hasImage = (msgs) => msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));

function serve(handler) {
  const server = http.createServer((req, res) => {
    server.hits = (server.hits || 0) + 1;
    res.on("error", () => {}); // a cancelled run aborts mid-response
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let o = {};
      try { o = JSON.parse(body || "{}"); } catch {}
      handler(o, res);
    });
  });
  server.hits = 0;
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const providerFor = (server) => ({ type: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "" });

// (a) Full model: calls tools, sees the red image.
const full = await serve((o, res) => {
  if (o.tools && o.tools.length) return sse(res, callEcho());
  return sse(res, say(hasImage(o.messages) ? "red" : "ready"));
});
// (b) No tools: 404 on any tools request; vision + text fine.
const noTools = await serve((o, res) => {
  if (o.tools && o.tools.length) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "No endpoints found that support tool use.", code: 404 } }));
  }
  return sse(res, say(hasImage(o.messages) ? "red" : "ready"));
});
// (c) Text-only: accepts tools but never calls; rejects images with a 400.
const textOnly = await serve((o, res) => {
  if (hasImage(o.messages)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "This model does not support image input." } }));
  }
  return sse(res, say("ready")); // even with tools, just replies text
});

const a = await testModel(providerFor(full), "full");
ok(a.text.status === "ok", `full: text ok (${a.text.detail})`);
ok(a.tools.status === "ok", `full: tools ok (${a.tools.detail})`);
ok(a.vision.status === "ok", `full: vision ok (${a.vision.detail})`);

const b = await testModel(providerFor(noTools), "no-tools");
ok(b.tools.status === "fail" && /tool-calling endpoint/.test(b.tools.detail), `no-tools: tools flagged as fail (${b.tools.detail})`);
ok(b.vision.status === "ok", `no-tools: vision still ok (${b.vision.detail})`);

const c = await testModel(providerFor(textOnly), "text-only");
ok(c.tools.status === "warn", `text-only: tools = warn, accepted but no call (${c.tools.detail})`);
ok(c.vision.status === "fail" && /rejected the image/.test(c.vision.detail), `text-only: vision flagged as fail (${c.vision.detail})`);

// --- Progress reporting: one callback per probe, in order, then "done". ---
const stages = [];
await testModel(providerFor(full), "full", { onProgress: (s) => stages.push(s) });
ok(JSON.stringify(stages) === JSON.stringify(["text", "tools", "vision", "done"]), `onProgress reports each stage in order (got ${stages.join(",")})`);

// --- Cancellation: a signal that is already aborted never hits the network. ---
const preAborted = new AbortController();
preAborted.abort();
const hitsBefore = full.hits;
const pre = await testModel(providerFor(full), "full", { signal: preAborted.signal });
ok(pre.aborted === true, `pre-aborted: result carries aborted:true (got ${pre.aborted})`);
ok(
  ["text", "tools", "vision"].every((k) => pre[k].status === "warn" && pre[k].detail === "cancelled"),
  `pre-aborted: every probe reports "cancelled" (got ${JSON.stringify(pre)})`,
);
ok(full.hits === hitsBefore, `pre-aborted: no HTTP request was made (${full.hits - hitsBefore} extra hits)`);

// --- Cancellation mid-run: abort while the tools probe is open. ---
// (d) Text answers; the tools request is accepted and never answered.
const hangs = await serve((o, res) => {
  if (o.tools && o.tools.length) return; // leave it hanging until the client gives up
  return sse(res, say(hasImage(o.messages) ? "red" : "ready"));
});
const mid = new AbortController();
const d = await testModel(providerFor(hangs), "hangs", {
  signal: mid.signal,
  onProgress: (s) => {
    if (s === "tools") setTimeout(() => mid.abort(), 50);
  },
});
ok(d.aborted === true, `mid-run abort: result carries aborted:true (got ${d.aborted})`);
ok(d.text.status === "ok", `mid-run abort: the finished text probe keeps its result (got ${JSON.stringify(d.text)})`);
ok(
  d.tools.detail === "cancelled" && d.vision.detail === "cancelled",
  `mid-run abort: the open and unrun probes report "cancelled" (got ${JSON.stringify({ tools: d.tools, vision: d.vision })})`,
);
ok(hangs.hits === 2, `mid-run abort: the vision probe was never sent (${hangs.hits} requests)`);

// --- Thinking models: the whole budget goes on thoughts, no answer. ---
// (e) Ollama's thinking builds: thoughts in delta.reasoning, never any content.
const thinks = await serve((o, res) =>
  sse(res, [
    { choices: [{ delta: { role: "assistant" } }] },
    ...Array.from({ length: 4 }, () => ({ choices: [{ delta: { reasoning: "Hmm, the user..." } }] })),
    { choices: [{ finish_reason: "length" }] },
  ]),
);
const e = await testModel(providerFor(thinks), "qwen3-vl:8b");
ok(e.text.status === "warn" && /thinking/.test(e.text.detail), `thinking: text = warn, mentions thinking (${JSON.stringify(e.text)})`);
ok(e.tools.status === "warn" && /thinking/.test(e.tools.detail), `thinking: tools = warn, mentions thinking (${JSON.stringify(e.tools)})`);
ok(e.vision.status === "warn" && /thinking/.test(e.vision.detail), `thinking: vision = warn, mentions thinking (${JSON.stringify(e.vision)})`);
ok(e.thinking === true, `thinking: result carries thinking:true (got ${e.thinking})`);
ok(
  e.text.thinking === true && e.tools.thinking === true && e.vision.thinking === true,
  `thinking: each probe carries thinking:true (${JSON.stringify([e.text.thinking, e.tools.thinking, e.vision.thinking])})`,
);

// A model that thinks and then answers within the budget is just a model.
const thinksThenAnswers = await serve((o, res) => {
  const think = { choices: [{ delta: { reasoning_content: "The user wants..." } }] };
  if (o.tools && o.tools.length) return sse(res, [think, ...callEcho()]);
  return sse(res, [think, ...say(hasImage(o.messages) ? "red" : "ready")]);
});
const t = await testModel(providerFor(thinksThenAnswers), "thinks-then-answers");
ok(t.text.status === "ok" && t.tools.status === "ok" && t.vision.status === "ok", `thinks then answers: every probe ok (${JSON.stringify(t)})`);
ok(t.thinking === undefined, `thinks then answers: no thinking flag (got ${t.thinking})`);
ok(
  [t.text, t.tools, t.vision].every((p) => p.thinking === undefined),
  "thinks then answers: no probe carries a thinking flag",
);

// (f) A local server whose origin allow-list leaves the extension out: a bare
// 403 with an empty body on every request.
const forbidden = await serve((o, res) => {
  res.writeHead(403);
  res.end();
});
const f = await testModel(providerFor(forbidden), "qwen3-vl:8b-instruct");
ok(f.text.status === "fail" && f.text.httpStatus === 403, `forbidden: text = fail with httpStatus 403 (${JSON.stringify(f.text)})`);
ok(f.tools.httpStatus === 403 && f.vision.httpStatus === 403, `forbidden: tools and vision carry httpStatus 403 (${JSON.stringify({ tools: f.tools, vision: f.vision })})`);
ok(f.thinking === undefined, `forbidden: no thinking flag (got ${f.thinking})`);
ok(a.text.httpStatus === undefined && b.text.httpStatus === undefined, "probes that got an answer carry no httpStatus");
ok(b.tools.httpStatus === 404, `no-tools: the 404 is recorded as httpStatus (got ${b.tools.httpStatus})`);
ok(
  b.tools.detail === "no tool-calling endpoint for this model" && b.tools.thinking === undefined && b.thinking === undefined,
  `no-tools: a hard tools failure carries no thinking flag (${JSON.stringify(b.tools)})`,
);

// (g) An inline <think> block the token cap cut off before it closed.
const inlineThink = await serve((o, res) =>
  sse(res, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: "<think>\nthe user wants" } }] },
    { choices: [{ finish_reason: "length" }] },
  ]),
);
const g = await testModel(providerFor(inlineThink), "inline-think");
ok(g.thinking === true, `inline think: result carries thinking:true (got ${g.thinking})`);
ok(g.text.status === "warn" && /thinking/.test(g.text.detail), `inline think: text = warn, mentions thinking (${JSON.stringify(g.text)})`);
ok(g.tools.status === "warn" && /thinking/.test(g.tools.detail), `inline think: tools = warn, mentions thinking (${JSON.stringify(g.tools)})`);
ok(g.text.thinking === true && g.tools.thinking === true, `inline think: text and tools carry thinking:true (${JSON.stringify([g.text, g.tools])})`);

// (h) A hosted-style reasoning model that thinks briefly, then answers in text
// and stops on its own: not a thinking failure, just no tool call.
const thinksBriefly = await serve((o, res) =>
  sse(res, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { reasoning: "short thought" } }] },
    { choices: [{ delta: { content: "I cannot use tools" } }] },
    { choices: [{ finish_reason: "stop" }] },
  ]),
);
const h = await testModel(providerFor(thinksBriefly), "thinks-briefly");
ok(h.text.status === "ok", `thinks briefly: text = ok (${JSON.stringify(h.text)})`);
ok(
  h.tools.status === "warn" && h.tools.detail === "accepted tools but didn't call one",
  `thinks briefly: tools = warn, didn't call one (${JSON.stringify(h.tools)})`,
);
ok(
  h.thinking === undefined && [h.text, h.tools, h.vision].every((p) => p.thinking === undefined),
  `thinks briefly: no thinking flag anywhere (${JSON.stringify(h)})`,
);

// (i) Content that merely starts with "<think>" and stops on its own: not cut
// off by the token cap, so not flagged.
const thinkTagStops = await serve((o, res) =>
  sse(res, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: "<think> tags wrap reasoning" } }] },
    { choices: [{ finish_reason: "stop" }] },
  ]),
);
const i = await testModel(providerFor(thinkTagStops), "think-tag-stops");
ok(
  i.thinking === undefined && [i.text, i.tools, i.vision].every((p) => p.thinking === undefined),
  `think tag, stopped: not flagged (${JSON.stringify(i)})`,
);
ok(i.text.status === "ok", `think tag, stopped: text = ok (${JSON.stringify(i.text)})`);

full.close();
noTools.close();
textOnly.close();
hangs.close();
hangs.closeAllConnections?.();
thinks.close();
thinksThenAnswers.close();
forbidden.close();
inlineThink.close();
thinksBriefly.close();
thinkTagStops.close();
console.log(fail ? "\nSOME PROBE TESTS FAILED" : "\nALL PROBE TESTS PASSED");
process.exit(fail);
