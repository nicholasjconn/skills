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

### Private HTTPS with Tailscale

Prefer Tailscale Serve when it is installed, connected, and HTTPS certificates
are enabled for the tailnet. Check `tailscale status --json` and live CLI help;
then add `--tailscale` to the normal launch on Linux or macOS:

```bash
node "$SCRIPT" /absolute/path/to/page.html --tailscale --async \
  --output /absolute/path/to/result.json
```

The listener stays on loopback. The runtime allocates an unused HTTPS port,
holds a foreground Serve session for this review, and verifies the returned
HTTPS URL before reporting readiness. `--tailscale-port PORT` requests a
specific unused external port; `--port` controls the separate local listener.
Existing Serve routes remain in place. Do not use Funnel, reset Serve, replace
an existing route, or combine this mode with `--host` or direct TLS flags.

Give the user the returned URL. Their other device must be connected to the
tailnet and permitted by its access rules. Tailnet peers with access can read
the allowed file tree or use the proxied application's routes and WebSockets.
The DNS hostname appears in public certificate logs; the content stays private.

If Tailscale is unavailable, report that the normal loopback URL works only on
this computer. Once `--tailscale` is selected, startup failures are fatal; do
not silently switch to a local URL. Missing login, HTTPS enablement, or device
enrollment is a setup prerequisite, not permission to perform that setup.

Submit, cancel, timeout, or worker termination releases this review's Serve
session. Logs, drafts, submissions, and startup readiness files are retained;
do not delete artifacts without the user's approval.

For a trusted-LAN review, `--host IPV4` accepts only an active, non-loopback IPv4 address assigned to this machine. The server binds and advertises only that address, never `0.0.0.0`. The review server has no authentication: any LAN peer that reaches that interface can access the entire allowed file tree or, for loopback URL sources, proxy arbitrary routes, methods, bodies, and WebSockets to the local app. Use this mode only with the user's authorization and an appropriately trusted network.

Pages that need a secure context on the LAN (e.g. `Secure` cookies, `crypto.randomUUID`) can be reviewed over HTTPS: pass `--tls-cert PATH --tls-key PATH` (PEM files whose certificate names the review host, e.g. `subjectAltName=IP:<host>`). Use a certificate trusted by the reviewing device for reliable secure-context behavior. Keep the key outside a reviewed file's directory, which the review serves in full; the CLI rejects keys inside that tree, including symlinked paths.

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

## Definition of done

- The advertised review URL loads the intended document with its overlay.
- In Tailscale mode, HTTPS verification succeeds and the listener is loopback.
- Submitted feedback preserves comment targets and iframe paths in the output.
- Review completion stops its own forwarding session and preserves other routes.

## Hosted reuse

For applications embedding the annotation toolbar, see [EMBEDDING.md](EMBEDDING.md). The browser engine is shared; the local server and hosted application supply separate persistence/completion adapters. Keep consumer snapshots pinned to an upstream commit and update them without editing the copied engine independently.
