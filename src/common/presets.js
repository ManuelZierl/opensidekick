// Which preset a configured provider came from. Pure (no chrome APIs), so it is
// unit-testable in node.

import { PROVIDER_PRESETS } from "./constants.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_PRESETS = new Set(["ollama", "lmstudio"]);

function hostOf(url) {
  try {
    return new URL(url).host; // hostname plus any non-default port
  } catch {
    return "";
  }
}

// The host with any loopback name folded to "localhost", port kept.
function loopbackHostOf(url) {
  try {
    const u = new URL(url);
    return LOOPBACK.has(u.hostname) ? `localhost:${u.port}` : u.host;
  } catch {
    return "";
  }
}

// Providers added since presets carried suggestions record their `presetId`.
// Older ones are matched on the exact host of their base URL — never a suffix
// or substring, so api.venice.ai.evil.com is not Venice. The port is part of
// the host, which is what tells Ollama (localhost:11434) from LM Studio
// (localhost:1234). For those two loopback presets only, localhost, 127.0.0.1
// and [::1] count as the same host (the port must still match). Returns the
// preset, or null.
export function presetFor(provider) {
  if (!provider) return null;
  if (provider.presetId) {
    const byId = PROVIDER_PRESETS.find((p) => p.id === provider.presetId);
    if (byId) return byId;
  }
  const host = hostOf(provider.baseUrl);
  if (!host) return null;
  const loopHost = loopbackHostOf(provider.baseUrl);
  return (
    PROVIDER_PRESETS.find((p) =>
      !p.baseUrl ? false : LOOPBACK_PRESETS.has(p.id) ? loopbackHostOf(p.baseUrl) === loopHost : hostOf(p.baseUrl) === host,
    ) || null
  );
}
