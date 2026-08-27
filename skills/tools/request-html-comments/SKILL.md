---
name: request-html-comments
description: Request and return element- or text-linked comments on a local HTML file or loopback-served page through an interactive browser overlay. Use when the user wants to annotate local HTML; do not use for remote URLs, browser automation, or code review.
license: MIT
---

# Request HTML Comments

Collect comments on an existing `.html`/`.htm` file or an already-running `http://` loopback page. File reviews may load assets only from the file's directory tree. Served-page reviews proxy the chosen loopback origin, including APIs and WebSockets.

The overlay annotates the top document and nested same-origin frames, including frames in open shadow roots, while preserving `iframe_path` through multiple levels. Same-origin frame support covers ordinary and axis-aligned scale/translation layouts only; targets behind rotated, skewed, or 3D frame ancestry are unavailable for annotation. Cross-origin, opaque-origin, and closed-shadow-root frames are context only: never try to inspect them or inject review controls into them.

## Launch

Inspect live help, then choose a new output path in a temporary directory:

```bash
SCRIPT="<skill-directory>/scripts/html_review.mjs"
node "$SCRIPT" --help
node "$SCRIPT" /absolute/path/to/page.html --async \
  --output /absolute/path/to/result.json
node "$SCRIPT" http://localhost:3000/page --async \
  --output /absolute/path/to/result.json
```

Use `--no-open` for automation-only validation and `--port PORT` when the URL must retain a specific available port. Bind failures are fatal rather than silently selecting another port.

For a trusted-LAN review, `--host IPV4` accepts only an active, non-loopback IPv4 address assigned to this machine. The server binds and advertises only that address, never `0.0.0.0`. The review server has no authentication: any LAN peer that reaches that interface can access the entire allowed file tree or, for loopback URL sources, proxy arbitrary routes, methods, bodies, and WebSockets to the local app. Use this mode only with the user's authorization and an appropriately trusted network.

Each invocation starts with zero comments. Use `--restore-comments` only when the user explicitly asks to recover an interrupted review, never to preload submitted feedback, and always use a new output path:

```bash
node "$SCRIPT" /absolute/path/to/page.html --async \
  --output /absolute/path/to/new-result.json \
  --restore-comments /absolute/path/to/prior-result.draft.json
```

For `result.json`, record:

- `result.json`: submitted feedback, created only after **Send**
- `result.draft.json`: autosaved recovery state
- `result.log`: worker diagnostics

Then end the turn while the user reviews. Do not poll or keep the worker attached; the user must send another chat message.

## Validation and recovery

Before a complex transformed, adopted, iframe-based, or dynamically rendered surface is handed to the user, perform representative browser validation through the injected overlay. Confirm nested descendants can be targeted and that a temporary comment records the intended selector and iframe path. Run that check with `--no-open`, cancel it, close the automation browser, and open exactly one fresh user-facing review with a new output path. Simpler static pages do not require an elaborate smoke run.

On the next user message:

- If feedback was sent, read the submission once and return every comment with target data intact.
- If the browser closed or crashed, inspect the log once. Recover the draft only when explicitly requested, and identify it as autosaved rather than submitted.
- If the review was cancelled, do not recover the draft unless asked.

Address submitted comments after returning them.
