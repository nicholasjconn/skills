---
name: request-html-comments
description: >-
  Request and return element- or text-linked comments on a local HTML file or
  loopback-served page through an interactive browser overlay. Use when the user
  wants to annotate local HTML; do not use for remote URLs, browser automation,
  or code review.
license: MIT
---

# Request HTML Comments

Review an existing `.html`/`.htm` file or running `http://` loopback app.
File reviews annotate one HTML file and load assets only within its directory
tree; linked HTML files need separate reviews. App reviews proxy the chosen
origin, including APIs and WebSockets, and can span its pages. Section links
can hide comment markers without deleting saved comments.

External OAuth/session-refresh returns may reach other app paths or queries
only through explicit top-level document navigation. Controls, fetches, frames,
writes, and WebSockets retain their origin restrictions.

Comments support nested same-origin frames, including open shadow roots.
Cross-origin, opaque-origin, and closed-shadow-root frames cannot be annotated.
Frames with rotated, skewed, or 3D-transformed ancestry are unsupported. Warn
the user when these limits affect their page; do not inspect or inject review
controls into inaccessible frames.

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

Use `--no-open` for automation-only validation and `--port PORT` when the URL
must retain a specific available port. Bind failures are fatal rather than
silently selecting another port.

For another device or a trusted HTTPS context, read
[networking](references/networking.md) before choosing Tailscale, LAN binding,
or direct TLS. The server has no authentication; LAN exposure requires the
user's authorization and a trusted network.

Each launch starts empty. Use `--restore-comments` only for explicitly requested
interrupted-review recovery, never to preload submitted feedback. Choose a new
output path:

```bash
node "$SCRIPT" /absolute/path/to/page.html --async \
  --output /absolute/path/to/new-result.json \
  --restore-comments /absolute/path/to/prior-result.draft.json
```

For `result.json`, record:

- `result.json`: submitted feedback, created only after **Send**
- `result.draft.json`: autosaved recovery state
- `result.log`: worker diagnostics
- `.html-review-<random>.ready`: retained async startup URL handshake

Submit, cancel, the 12-hour safety timeout, or worker termination stops the
review and releases its forwarding session. Timeout does not submit feedback.
Logs, drafts, and submitted feedback remain available. Cleanup failures are
reported separately. Saved feedback survives; submission exits nonzero if
cleanup is incomplete. Cancellation/error outcomes are retained.

Then end the turn while the user reviews. Do not poll or keep the worker
attached; the user must send another chat message.

## Validation and recovery

For complex transformed, adopted, iframe-based, or dynamic surfaces, validate
representative targets through the overlay before handoff. With `--no-open`,
check that a temporary comment records the intended nested target and iframe
path. Cancel that review, close the automation browser, then open one fresh
user-facing review with a new output path. Simple static pages need no elaborate
smoke run.

On the next user message:

- If feedback was sent, read the submission once and return every comment with
  its page and target data intact.
- If the browser closed or crashed, inspect the log once. Recover the draft only
  when explicitly requested, and identify it as autosaved rather than submitted.
- If the review was cancelled, do not recover the draft unless asked.

Address submitted comments after returning them.

## Definition of done

- The advertised review URL loads the intended document with its overlay.
- Submitted feedback preserves comment targets and iframe paths in the output.
- Review completion stops its own forwarding session and preserves other routes.

## Hosted reuse

For applications embedding the annotation toolbar, see
[EMBEDDING.md](EMBEDDING.md).
