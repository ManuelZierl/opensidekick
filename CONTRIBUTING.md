# Contributing to OpenSidekick

Thanks for your interest! OpenSidekick is intentionally simple: plain ES modules,
no build step, no npm runtime dependencies. That makes it easy to hack on.

## Getting set up

1. Clone the repo.
2. Load it as an unpacked extension at `chrome://extensions` (Developer mode →
   Load unpacked).
3. Make changes and hit the reload icon on the extension card to pick them up.
   Reload the target page after changing `content-script.js`.

## Before opening a PR

```bash
npm run check   # syntax-checks every JS file as an ES module
npm run icons   # only if you changed the icon generator
```

Please:

- Keep the no-build constraint. If a change needs a build tool, open an issue
  to discuss first.
- No npm runtime dependencies. A third-party library may be vendored, case by
  case. Open an issue before adding one. A vendored library must be:
  - pinned to one released version;
  - copied byte-for-byte from the official npm package, with the file named
    and its sha256 in a header comment;
  - shipped with its license, plus the notices of every package bundled
    inside it;
  - loaded as plain scripts or ES modules, with no build step.
  To upgrade one, copy the new release the same way, and update its header
  and notices in the same PR.
- Match the existing style (2-space indent, ES modules, descriptive comments
  that explain _why_, not _what_).
- Keep provider code protocol-agnostic — new hosted services that speak
  OpenAI's `/chat/completions` should work by adding a preset in
  `src/common/constants.js`, not new code.
- Don't add analytics, telemetry, or any phone-home behavior. Privacy is a core
  promise of this project.

## Good first issues

- New provider presets (verify the base URL and default model).
- Improving the page-reading heuristics in `content-script.js`.
- Accessibility and keyboard-navigation improvements in the UI.

## Architecture at a glance

The agent loop lives in `src/background/agent.js`. It calls the model
(`providers.js`), executes any tool calls (`tools.js` + `content-script.js`),
gates mutating actions (`permissions.js`), and streams events to the side panel.
Start there to understand how a task runs end to end.

## Reporting bugs

Include your Chrome version, the provider/model you used, the site you were on
(if shareable), and the steps to reproduce. Console logs from the service worker
(`chrome://extensions` → Inspect views: service worker) are very helpful.

By contributing you agree your contributions are licensed under the MIT License.
