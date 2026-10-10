import {
  MESSAGE_MAX_CHARS,
  SESSION_MAX_BYTES,
  TRIM_MARK,
  SCREENSHOT_PLACEHOLDER,
  byteLength,
  stripImages,
  visibleTurns,
  capTurns,
  titleFrom,
  normalizeTitle,
  emptyIndex,
  readIndex,
  upsertSession,
  removeSession,
  reconcileIndex,
  planSave,
  observedUrl,
  touchesSensitiveSite,
  relativeTime,
} from "../src/background/sessions.js";
import { SESSIONS_MAX } from "../src/common/constants.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const user = (content, extra = {}) => ({ role: "user", content, ...extra });
const asst = (content, extra = {}) => ({ role: "assistant", content, ...extra });
const tool = (name, result) => ({ role: "tool", toolCallId: "c-" + name, name, content: JSON.stringify(result) });
const item = (id, updatedAt, extra = {}) => ({ id, title: "chat " + id, createdAt: updatedAt, updatedAt, model: "m", provider: "P", ...extra });

// --- visibleTurns ---
{
  const v = visibleTurns([user("Hi"), asst("Hello there.")]);
  ok(same(v, [user("Hi"), asst("Hello there.")]), "visibleTurns: keeps user prompts and assistant text");
}
{
  const v = visibleTurns([
    user("Search cats"),
    asst("", { toolCalls: [{ id: "a", name: "read_page", args: {} }] }),
    tool("read_page", { ok: true, url: "https://a.test/", elements: [{ ref: 1 }] }),
    asst("Done.", { toolCalls: [{ id: "b", name: "click_element", args: { ref: 1 } }] }),
  ]);
  ok(same(v, [user("Search cats"), asst("Done.")]), "visibleTurns: drops tool messages and tool calls");
  ok(v.every((m) => Object.keys(m).join() === "role,content"), "visibleTurns: drops tool messages and tool calls (no extra fields)");
}
{
  const v = visibleTurns([
    user("Look at this"),
    user("Here is the screenshot you requested:", { images: [{ mediaType: "image/png", data: "x" }], internal: true }),
    user("plumbing", { internal: true }),
    user("pic", { images: [{ mediaType: "image/png", data: "x" }] }),
    asst("I see a chart."),
  ]);
  ok(same(v, [user("Look at this"), asst("I see a chart.")]), "visibleTurns: drops internal and image-carrying user messages");
}
{
  const v = visibleTurns([user("Do it"), asst("  ", { toolCalls: [{ name: "finish", args: { summary: "Typed it." } }] })]);
  ok(same(v, [user("Do it"), asst("Typed it.")]), "visibleTurns: uses the finish summary when the assistant text is empty");
}
{
  const v = visibleTurns([user("Do it"), asst("", { toolCalls: [{ name: "read_page", args: {} }] }), asst(null)]);
  ok(same(v, [user("Do it")]), "visibleTurns: drops an assistant turn with no text and no finish");
}
{
  const v = visibleTurns([user("Q"), asst("First."), tool("read_page", { ok: true }), asst(" Second. ")]);
  ok(same(v, [user("Q"), asst("First.\n\nSecond.")]), "visibleTurns: merges consecutive assistant turns with a blank line");
}
{
  const v = visibleTurns([user("one"), user("two"), asst("ok")]);
  ok(same(v, [user("one"), user("two"), asst("ok")]), "visibleTurns: keeps consecutive user prompts separate");
}
{
  const convo = [user("a"), asst("b"), asst("", { toolCalls: [{ name: "finish", args: { summary: "c" } }] }), user("d")];
  const once = visibleTurns(convo);
  ok(same(visibleTurns(once), once), "visibleTurns: is idempotent");
  ok(convo[1].content === "b" && convo.length === 4, "visibleTurns: is idempotent (input untouched)");
}
{
  ok(same(visibleTurns(null), []), "visibleTurns: tolerates null, non-arrays and malformed messages (null)");
  ok(same(visibleTurns("x"), []) && same(visibleTurns({}), []), "visibleTurns: tolerates null, non-arrays and malformed messages (non-arrays)");
  const v = visibleTurns([null, 7, "s", {}, { role: "user", content: 5 }, { role: "user", content: "" }, { role: "assistant", content: { x: 1 }, toolCalls: "no" }, user("real")]);
  ok(same(v, [user("real")]), "visibleTurns: tolerates null, non-arrays and malformed messages (junk items)");
}

// --- stripImages ---
{
  const plain = user("hi");
  const toolMsg = tool("read_page", { ok: true });
  const shot = user("", { images: [{ mediaType: "image/png", data: "x" }], internal: true });
  const captioned = user("Here is the screenshot you requested:", { images: [{ mediaType: "image/png", data: "x" }], internal: true });
  const out = stripImages([plain, toolMsg, shot, captioned]);
  ok(out[0] === plain && out[1] === toolMsg, "stripImages: replaces images with the placeholder and leaves other messages identical (others)");
  ok(out[2].images === undefined && out[2].content === SCREENSHOT_PLACEHOLDER && out[2].internal === true,
    "stripImages: replaces images with the placeholder and leaves other messages identical (empty caption)");
  ok(out[3].images === undefined && out[3].content === "Here is the screenshot you requested:",
    "stripImages: replaces images with the placeholder and leaves other messages identical (caption kept)");
  ok(shot.images.length === 1, "stripImages: replaces images with the placeholder and leaves other messages identical (input untouched)");
}

// --- capTurns ---
{
  const turns = [user("a"), asst("b"), user("c"), asst("d")];
  ok(same(capTurns(turns), turns), "capTurns: leaves a small chat unchanged");
}
{
  const long = "x".repeat(MESSAGE_MAX_CHARS + 500);
  const out = capTurns([user("q"), asst(long)]);
  ok(out[1].content === "x".repeat(MESSAGE_MAX_CHARS) + TRIM_MARK, "capTurns: trims a message over the per-message cap and marks it");
  ok(capTurns([user("q"), asst("x".repeat(MESSAGE_MAX_CHARS))])[1].content.length === MESSAGE_MAX_CHARS,
    "capTurns: trims a message over the per-message cap and marks it (exactly at the cap is untouched)");
}
{
  // 30 exchanges of ~10 KB each are ~300 KB, over the 200 KiB cap.
  const turns = [];
  for (let i = 0; i < 30; i++) turns.push(user(`q${i} ` + "u".repeat(5000)), asst(`a${i} ` + "a".repeat(5000)));
  const out = capTurns(turns);
  ok(byteLength(out) <= SESSION_MAX_BYTES, "capTurns: drops the oldest exchanges until the chat fits");
  ok(out.length < turns.length && out[out.length - 1].content.startsWith("a29 "), "capTurns: drops the oldest exchanges until the chat fits (newest kept)");
  ok(byteLength(capTurns(turns, { maxBytes: byteLength(out) + 10100 })) > byteLength(out), "capTurns: drops the oldest exchanges until the chat fits (no more than needed)");
}
{
  const out = capTurns([asst("orphan reply"), user("q1"), asst("a1"), user("q2"), asst("a2")], { maxBytes: 60 });
  ok(out[0].role === "user", "capTurns: the result always starts with a user turn");
  ok(capTurns([asst("orphan reply"), user("q"), asst("a")])[0].content === "q", "capTurns: the result always starts with a user turn (no trimming needed)");
}
{
  const out = capTurns([user("q1"), asst("a1"), user("q2-long"), asst("a2-long")], { maxBytes: 10, maxMessageChars: 100 });
  ok(same(out, [user("q2-long"), asst("a2-long")]), "capTurns: keeps the last exchange whole (small custom limits)");
  const cut = capTurns([user("q1"), asst("a1"), user("q2"), asst("y".repeat(50))], { maxBytes: 10, maxMessageChars: 20 });
  ok(cut.length === 2 && cut[1].content === "y".repeat(20) + TRIM_MARK, "capTurns: keeps the last exchange whole (small custom limits, still char-capped)");
}
{
  // Three-byte chars: a char budget would keep both exchanges, a byte budget can't.
  const cjk = "漢".repeat(30);
  const turns = [user("q1"), asst(cjk), user("q2"), asst(cjk)];
  const chars = JSON.stringify(turns).length;
  const out = capTurns(turns, { maxBytes: chars + 10 });
  ok(byteLength(turns) > chars + 10 && out.length === 2 && out[0].content === "q2", "capTurns: measures UTF-8 bytes, not characters");
  ok(byteLength("漢") === 5, "capTurns: measures UTF-8 bytes, not characters (byteLength)");
}

// --- titleFrom and normalizeTitle ---
ok(titleFrom("  Summarize   this\n page  ") === "Summarize this page", "titleFrom: the first prompt with whitespace collapsed");
{
  const t = titleFrom("word ".repeat(30));
  ok(t.length <= 60 && t.endsWith("…") && !t.endsWith(" …"), "titleFrom: long prompts are cut to 60 characters with an ellipsis");
  ok(titleFrom("x".repeat(60)) === "x".repeat(60) && titleFrom("x".repeat(61)) === "x".repeat(59) + "…",
    "titleFrom: long prompts are cut to 60 characters with an ellipsis (boundary)");
}
ok(
  titleFrom('Regarding this selected text from the page:\n\n"""The quick\nbrown fox"""\n\nPlease help me with it.') === "The quick brown fox",
  "titleFrom: a context-menu seed becomes the selected text",
);
{
  const steps = "Steps:\n1. Click search";
  const plain = `Replay this saved workflow named "Daily report". Perform each step in order.\n\n${steps}`;
  const withUrl = `First make sure the current tab is at https://a.test/ (navigate there if it isn't). Then Replay this saved workflow named "Daily report". Perform.\n\n${steps}`;
  ok(titleFrom(plain) === "Replay: Daily report" && titleFrom(withUrl) === "Replay: Daily report",
    'titleFrom: a workflow replay becomes "Replay: <name>" (with and without a start URL)');
}
ok(titleFrom('Replay this saved workflow named "My "big" flow". Perform each step in order.') === 'Replay: My "big" flow',
  "titleFrom: a workflow name with quotes in it is kept whole");
ok(titleFrom("") === "Untitled chat" && titleFrom("  \n ") === "Untitled chat" && titleFrom(null) === "Untitled chat",
  'titleFrom: blank input becomes "Untitled chat"');
ok(normalizeTitle("  Plum \n chat ") === "Plum chat" && normalizeTitle("y".repeat(100)) === "y".repeat(80),
  "normalizeTitle: trims, collapses and caps at 80");
ok(normalizeTitle("") === null && normalizeTitle("   ") === null && normalizeTitle(null) === null && normalizeTitle(42) === null,
  "normalizeTitle: blank or non-string input is rejected (null)");

// --- readIndex ---
ok(same(readIndex(null), emptyIndex()) && same(readIndex("x"), emptyIndex()) && same(readIndex({ items: "no" }), emptyIndex()),
  "readIndex: null or garbage gives an empty index");
{
  const idx = readIndex({
    v: 1,
    currentId: null,
    items: [item("a", 5), null, { id: 3, updatedAt: 1 }, { id: "", updatedAt: 1 }, { id: "b", updatedAt: "x" }, { id: "c" }, item("a", 2), item("d", 4)],
  });
  ok(same(idx.items.map((i) => i.id), ["a", "d"]), "readIndex: drops malformed items and duplicate ids");
  ok(idx.items[0].updatedAt === 5, "readIndex: drops malformed items and duplicate ids (keeps the newest copy)");
}
{
  const items = [];
  for (let i = 0; i < 25; i++) items.push(item("s" + i, 1000 + i));
  const idx = readIndex({ v: 1, currentId: null, items });
  ok(idx.items.length === SESSIONS_MAX && idx.items[0].id === "s24" && idx.items[19].id === "s5", "readIndex: sorts newest first and caps at 20");
}
ok(readIndex({ v: 1, currentId: "gone", items: [item("a", 1)] }).currentId === null && readIndex({ v: 1, currentId: "a", items: [item("a", 1)] }).currentId === "a",
  "readIndex: a currentId that isn't listed becomes null");

// --- upsertSession and removeSession ---
{
  const base = { v: 1, currentId: null, items: [item("a", 10), item("b", 5)] };
  const { index, evicted } = upsertSession(base, item("n", 20));
  ok(same(index.items.map((i) => i.id), ["n", "a", "b"]) && evicted.length === 0, "upsertSession: a new chat goes to the top");
}
{
  const base = { v: 1, currentId: null, items: [item("a", 10), item("b", 5, { title: "Mine", createdAt: 1 })] };
  const { index } = upsertSession(base, { id: "b", title: "New title", createdAt: 99, updatedAt: 30, model: "m2", provider: "P2" });
  const b = index.items[0];
  ok(b.id === "b" && b.title === "Mine" && b.createdAt === 1 && b.updatedAt === 30 && b.model === "m2" && b.provider === "P2",
    "upsertSession: an update keeps title and createdAt, refreshes updatedAt, model and provider");
}
{
  const items = [];
  for (let i = 0; i < 20; i++) items.push(item("s" + i, 100 + i));
  const { index, evicted } = upsertSession({ v: 1, currentId: null, items }, item("new", 500));
  ok(index.items.length === 20 && same(evicted, ["s0"]) && !index.items.some((i) => i.id === "s0"),
    "upsertSession: the 21st chat evicts the oldest and reports it");
}
{
  // The chat being saved has the oldest updatedAt it can have; it still stays.
  const items = [item("a", 10), item("b", 20)];
  const { index, evicted } = upsertSession({ v: 1, currentId: null, items }, item("old", 1), { max: 2 });
  ok(index.items[0].id === "old" && same(evicted, ["a"]), "upsertSession: never evicts the chat being saved");
  const one = upsertSession({ v: 1, currentId: null, items: [item("a", 10)] }, item("a", 11), { max: 1 });
  ok(one.index.items.length === 1 && one.evicted.length === 0, "upsertSession: never evicts the chat being saved (update at the cap)");
}
{
  const base = { v: 1, currentId: "a", items: [item("a", 10), item("b", 5)] };
  const snap = JSON.stringify(base);
  upsertSession(base, item("b", 50));
  upsertSession(base, item("c", 50), { max: 1 });
  ok(JSON.stringify(base) === snap, "upsertSession: does not mutate its input");
}
{
  const base = { v: 1, currentId: "a", items: [item("a", 10), item("b", 5)] };
  const r = removeSession(base, "a");
  ok(same(r.items.map((i) => i.id), ["b"]) && r.currentId === null, "removeSession: removes the item and clears a matching currentId");
  ok(removeSession(base, "b").currentId === "a" && base.items.length === 2, "removeSession: removes the item and clears a matching currentId (other ids keep it)");
}
{
  const base = { v: 1, currentId: "a", items: [item("a", 10)] };
  ok(same(removeSession(base, "zzz"), base), "removeSession: an unknown id is a no-op");
}

// --- reconcileIndex ---
{
  const base = { v: 1, currentId: "b", items: [item("a", 10), item("b", 5)] };
  const r = reconcileIndex(base, ["a"]);
  ok(same(r.index.items.map((i) => i.id), ["a"]) && r.index.currentId === null && r.changed === true,
    "reconcileIndex: drops items whose body is missing");
  ok(reconcileIndex(base, ["a", "b"]).changed === false, "reconcileIndex: drops items whose body is missing (nothing missing, unchanged)");
}
{
  const base = { v: 1, currentId: null, items: [item("a", 10)] };
  const r = reconcileIndex(base, ["a", "x", "y"]);
  ok(same(r.orphans, ["x", "y"]) && r.changed === false, "reconcileIndex: reports bodies with no index item as orphans");
}

// --- planSave ---
const convo = [
  user("Search for cats on this page."),
  asst("", { toolCalls: [{ id: "a", name: "read_page", args: {} }] }),
  tool("read_page", { ok: true, url: "https://shop.test/", elements: [{ ref: 1, name: "Search" }] }),
  asst("", { toolCalls: [{ id: "f", name: "finish", args: { summary: 'Typed "cats" and clicked Search.' } }] }),
];
const save = (extra = {}) => planSave({
  index: emptyIndex(), sessionId: "s1", sensitive: false, conversation: convo, isCurrent: true,
  keepHistory: true, now: 1000, model: "mock-model", provider: "Mock", ...extra,
});
{
  const r = save({ keepHistory: false });
  ok(r.index === null && r.body === null && r.removeIds.length === 0, "planSave: history off writes nothing");
}
{
  const r = save();
  const it = r.index.items[0];
  ok(it.id === "s1" && it.title === "Search for cats on this page." && it.createdAt === 1000 && it.updatedAt === 1000 &&
    it.model === "mock-model" && it.provider === "Mock" && r.index.currentId === "s1",
    "planSave: first save titles the chat, stamps times, sets currentId");
}
{
  const r = save({ isCurrent: false, index: { v: 1, currentId: "other", items: [item("other", 5)] } });
  ok(r.index.currentId === "other" && r.index.items[0].id === "s1", "planSave: a chat that is no longer live doesn't take currentId");
}
{
  const first = save();
  const renamed = { ...first.index, items: [{ ...first.index.items[0], title: "Cat search" }] };
  const r = save({ index: renamed, now: 2000, conversation: [...convo, user("Now dogs"), asst("Done.")] });
  ok(r.index.items[0].title === "Cat search" && r.index.items[0].createdAt === 1000 && r.index.items[0].updatedAt === 2000,
    "planSave: a renamed title survives later saves");
}
{
  const long = "z".repeat(MESSAGE_MAX_CHARS + 10);
  const r = save({ conversation: [...convo, user("More"), asst(long)] });
  const json = JSON.stringify(r.body);
  ok(r.body.id === "s1" && r.body.messages.every((m) => m.role === "user" || m.role === "assistant"),
    "planSave: the saved body holds only visible, capped turns (roles)");
  ok(!json.includes('"elements"') && !json.includes('"role":"tool"') && r.body.messages[1].content === 'Typed "cats" and clicked Search.',
    "planSave: the saved body holds only visible, capped turns (no tool output)");
  ok(r.body.messages[3].content.endsWith(TRIM_MARK) && r.body.trimmed === undefined,
    "planSave: the saved body holds only visible, capped turns (capped, not marked as trimmed)");
}
{
  const before = { v: 1, currentId: "s1", items: [item("s1", 5), item("b", 4)] };
  const r = save({ sensitive: true, index: before });
  ok(r.body === null && same(r.removeIds, ["s1"]) && same(r.index.items.map((i) => i.id), ["b"]) && r.index.currentId === null,
    "planSave: a sensitive chat that was saved before is removed");
}
{
  const r = save({ sensitive: true, index: { v: 1, currentId: null, items: [item("b", 4)] } });
  ok(r.index === null && r.body === null && r.removeIds.length === 0, "planSave: a sensitive chat that was never saved writes nothing");
}
{
  const r = save({ conversation: [asst("Hello"), user("pic", { internal: true })] });
  ok(r.index === null && r.body === null && r.removeIds.length === 0, "planSave: a chat with no user turn writes nothing");
}
{
  const items = [];
  for (let i = 0; i < 20; i++) items.push(item("s" + (i + 10), 100 + i));
  const r = save({ index: { v: 1, currentId: "s10", items } });
  ok(same(r.removeIds, ["s10"]) && r.index.items.length === 20 && r.index.currentId === "s1", "planSave: evicted chats are listed for removal");
  const notLive = save({ isCurrent: false, index: { v: 1, currentId: "s10", items } });
  ok(notLive.index.currentId === null, "planSave: evicted chats are listed for removal (an evicted currentId is cleared)");
}
{
  const big = [];
  for (let i = 0; i < 30; i++) big.push(user(`q${i} ` + "u".repeat(5000)), asst(`a${i} ` + "a".repeat(5000)));
  ok(save({ conversation: big }).body.trimmed === true, "planSave: a chat that lost old exchanges is marked trimmed");
  ok(save({ trimmed: true }).body.trimmed === true && save().body.trimmed === undefined, "planSave: a chat that lost old exchanges is marked trimmed (sticky)");
}

// --- touchesSensitiveSite ---
const BANK = "https://my.bank.test/account";
ok(touchesSensitiveSite([user("q"), tool("read_page", { ok: true, url: BANK, elements: [] })]) === true,
  "touchesSensitiveSite: a read_page result on a bank host");
{
  const hits = ["navigate", "open_tab", "switch_tab", "take_screenshot", "get_page_text"].map((name) =>
    touchesSensitiveSite([tool(name, { ok: true, tab_id: 3, url: "https://www.paypal.com/myaccount", title: "PayPal" })]));
  ok(hits.every(Boolean), "touchesSensitiveSite: navigate / open_tab / switch_tab / take_screenshot results");
}
{
  // What truncateForModel stores for an oversized read_page result.
  const full = JSON.stringify({ ok: true, url: BANK, title: "Bank", elements: new Array(800).fill({ ref: 1, name: "row", url: "https://a.test/" }) });
  const truncated = { role: "tool", name: "read_page", content: JSON.stringify({ ok: true, note: "result truncated", preview: full.slice(0, 12000) }) };
  ok(observedUrl(truncated.content) === BANK && touchesSensitiveSite([truncated]) === true, "touchesSensitiveSite: a truncated read_page preview");
}
ok(touchesSensitiveSite([tool("run_javascript", { ok: true, url: BANK, result: '"Balance: 1,024.00"' })]) === true,
  "touchesSensitiveSite: a run_javascript result on a bank host");
{
  const listTabs = tool("list_tabs", { ok: true, tabs: [{ tab_id: 1, url: BANK, title: "Bank", active: false }] });
  const network = tool("read_network", { ok: true, url: "https://js.stripe.com/v3", requests: [{ url: BANK }] });
  ok(touchesSensitiveSite([listTabs, network]) === false, "touchesSensitiveSite: list_tabs and read_network that mention a bank URL don't count");
}
{
  const msgs = [
    tool("read_page", { ok: true, url: "https://shop.test/", elements: [] }),
    tool("navigate", { ok: false, error: "Navigation failed", url: BANK }),
    { role: "tool", name: "read_page", content: "not json" },
    { role: "tool", name: "read_page", content: null },
    asst("I looked at " + BANK),
    null,
  ];
  ok(touchesSensitiveSite(msgs) === false && touchesSensitiveSite(null) === false && touchesSensitiveSite("x") === false,
    "touchesSensitiveSite: ordinary sites, failed results and junk are false");
}

// --- relativeTime ---
{
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  ok(relativeTime(now - 59e3, now) === "just now" && relativeTime(now + 5e3, now) === "just now" && relativeTime(now, now) === "just now",
    'relativeTime: under a minute (and the future) is "just now"');
  ok(relativeTime(now - 60e3, now) === "1m ago" && relativeTime(now - 59 * 60e3, now) === "59m ago" &&
    relativeTime(now - 3600e3, now) === "1h ago" && relativeTime(now - 23.9 * 3600e3, now) === "23h ago",
    "relativeTime: minutes and hours");
  ok(relativeTime(now - 24 * 3600e3, now) === "yesterday" && relativeTime(now - 47 * 3600e3, now) === "yesterday" &&
    relativeTime(now - 48 * 3600e3, now) === "2d ago" && relativeTime(now - 6.9 * 86400e3, now) === "6d ago",
    'relativeTime: 24–48 h is "yesterday", then days');
  const march = new Date(2026, 2, 12, 12).getTime();
  const lastYear = new Date(2025, 2, 12, 12).getTime();
  ok(relativeTime(march, now, "en-GB") === "12 Mar" && relativeTime(lastYear, now, "en-GB") === "12 Mar 2025" &&
    relativeTime(now - 7 * 86400e3, now, "en-GB") === "3 Oct",
    "relativeTime: a week or more is a short date, with the year added when it differs");
}

console.log(fail ? "\nSOME SESSIONS TESTS FAILED" : "\nALL SESSIONS TESTS PASSED");
process.exit(fail);
