// Unit suite for the vendored libraries. Plain node, no browser, no deps.
// The promise these files make is byte-identity with the official npm package, so
// the check is the promise: the header names a sha256, and the file's body hashes
// to it. A header that no longer matches its file means the vendored code was
// edited, which is the one thing a vendored file must not do.

import fs from "node:fs";
import crypto from "node:crypto";

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else { console.log(`FAIL: ${label}`); fail++; }
};

const VENDOR = new URL("../src/common/vendor/", import.meta.url);
const files = fs.readdirSync(VENDOR).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();
const prism = fs.readdirSync(new URL("prism/", VENDOR)).filter((f) => f.endsWith(".js")).sort();
const all = [...files, ...prism.map((f) => `prism/${f}`)];

ok(all.length === 15, "the vendored set is 15 files (markdown-it + Prism core + 13 languages)");

for (const f of all) {
  const text = fs.readFileSync(new URL(f, VENDOR), "utf8");
  const claim = (text.match(/sha256 ([0-9a-f]{64})/) || [])[1];
  const body = text.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  ok(claim && claim === hash, `vendored ${f}: the header sha256 matches the file's body`);
}

// A vendored file that reaches for dynamic code or the network is a different
// kind of dependency than the one the header declares.
const offenders = all.filter((f) => {
  const body = fs.readFileSync(new URL(f, VENDOR), "utf8").replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  return /\beval\(|new Function|import\(|\bfetch\(/.test(body);
});
ok(offenders.length === 0, `no vendored file uses eval, new Function, dynamic import, or fetch (got ${JSON.stringify(offenders)})`);

const mdHeader = fs.readFileSync(new URL("markdown-it.mjs", VENDOR), "utf8").split("\n").slice(0, 5).join("\n");
const prismHeaders = prism.map((f) => fs.readFileSync(new URL("prism/" + f, VENDOR), "utf8").split("\n").slice(0, 5).join("\n"));
ok(mdHeader.includes("15.0.3") && prismHeaders.every((h) => h.includes("1.30.0")), "the headers name the pinned releases (markdown-it 15.0.3, Prism 1.30.0)");

const licenses = fs.readFileSync(new URL("markdown-it.LICENSE", VENDOR), "utf8") + fs.readFileSync(new URL("prism/Prism.LICENSE", VENDOR), "utf8");
ok(licenses.includes("Copyright"), "the license texts sit next to the vendored code");

// markdown-it's browser bundle inlines five packages and two sets of bundler
// helpers. Their licenses require their notices to travel with the code.
const notices = fs.readFileSync(new URL("markdown-it.NOTICES", VENDOR), "utf8");
const bundled = ["entities", "linkify-it", "mdurl", "punycode.js", "uc.micro", "rolldown", "@oxc-project/runtime"];
ok(bundled.every((p) => notices.includes(`\n${p} `)), `the notices of everything bundled in markdown-it ship next to it (${bundled.join(", ")})`);

// The license and notice texts are pinned, so a truncated or edited one fails.
const PINNED = {
  "markdown-it.LICENSE": "792c48c5a849a15fdf9e37e8bcf9e6d1dd13b32b46c642a748a0a46a9919d473",
  "prism/Prism.LICENSE": "2b947f0901a7ffcf08a89957da9783c0e9c6e72cb6ce8e959f501ab5409e4d2b",
  "markdown-it.NOTICES": "ad290001b0dec49104d0c45903ce5850ad48f41448107f566ae0a3487f33e6e8",
};
for (const [f, want] of Object.entries(PINNED)) {
  const got = crypto.createHash("sha256").update(fs.readFileSync(new URL(f, VENDOR))).digest("hex");
  ok(got === want, `${f} matches its pinned sha256 (${want.slice(0, 12)})`);
}

if (fail) process.exit(1);
console.log("\nALL VENDOR CHECKS PASSED");
