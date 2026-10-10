// Integration test for the model capability probe (testModel). Spins up mock
// OpenAI-compatible servers that behave like: (a) a full tools+vision model,
// (b) a vision model with no tool-calling endpoint (the user's Qwen-VL case),
// and (c) a text-only model that rejects images — and asserts the probe reports
// each correctly.

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

full.close();
noTools.close();
textOnly.close();
hangs.close();
hangs.closeAllConnections?.();
console.log(fail ? "\nSOME PROBE TESTS FAILED" : "\nALL PROBE TESTS PASSED");
process.exit(fail);
