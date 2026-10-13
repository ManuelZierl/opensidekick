// What the Settings model test says when a local model fails for a reason the
// user can fix: a thinking build that never answers, or a server that blocks
// the extension's origin. Pure (no DOM or chrome APIs), so it is unit-testable
// in node.

export const LOCAL_MODEL_README_URL = "https://github.com/esterhuizen/opensidekick#using-a-local-model-ollama-lm-studio";

// Local models need no key, so a loopback base URL is testable the moment a
// model id is there.
export function isLocalBaseUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

// "ollama" or "lmstudio" when the provider is one of those local servers: by
// its preset, else by the server's default port on a loopback base URL.
function localServer(provider) {
  if (provider.presetId === "ollama" || provider.presetId === "lmstudio") return provider.presetId;
  if (!isLocalBaseUrl(provider.baseUrl)) return null;
  const port = new URL(provider.baseUrl).port;
  return port === "11434" ? "ollama" : port === "1234" ? "lmstudio" : null;
}

// Ollama's plain qwen3-vl tags are the thinking builds. Each maps to the
// instruct build of the same size.
const INSTRUCT_TAGS = {
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

// The instruct tag for an Ollama qwen3-vl thinking tag, or null.
export function instructTagFor(model) {
  return Object.hasOwn(INSTRUCT_TAGS, model) ? INSTRUCT_TAGS[model] : null;
}

// The verdict when a model spent the test budget thinking. Plain text.
export function thinkingVerdict(provider, model) {
  const base = "This model thinks before it answers, and it used the whole test budget on thinking.";
  const tag = instructTagFor(model);
  if (tag && localServer(provider) === "ollama") return `${base} Use the instruct build instead: ${tag} (ollama pull ${tag}).`;
  return `${base} Pick a non-thinking (instruct) build of this model, or a different model.`;
}

// A local server that answers 403 is almost always blocking the extension's
// origin (a 401 is an authentication problem, not an origin block). Returns
// { text, readmeUrl } with the fix, or null.
export function corsHint(provider, status) {
  if (status !== 403) return null;
  if (!provider || !isLocalBaseUrl(provider.baseUrl)) return null;
  const server = localServer(provider);
  const text =
    server === "ollama"
      ? `Ollama blocked the extension (HTTP ${status}). Set OLLAMA_ORIGINS=chrome-extension://* where Ollama runs, restart Ollama, then press Test.`
      : server === "lmstudio"
        ? `LM Studio blocked the extension (HTTP ${status}). Switch on Enable CORS in the server settings, or start it with: lms server start --cors. Then press Test.`
        : `Your local server blocked the extension (HTTP ${status}). Allow requests from chrome-extension:// origins (CORS), then press Test.`;
  return { text, readmeUrl: LOCAL_MODEL_README_URL };
}
