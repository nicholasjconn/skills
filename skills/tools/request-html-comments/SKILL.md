---
name: request-html-comments
description: Use to request and return element- or text-linked comments on a local HTML file or loopback-served page through an interactive browser overlay. Trigger when the user wants to comment on or annotate local HTML. Do not use for remote URLs, browser automation, or code review.
---

# Request HTML Comments

## Requirements

- Use an existing `.html` or `.htm` file, or an already-running `http://` page
  on `localhost`, `127.0.0.1`, or `::1`.
- Keep the reviewed page and its assets on the user's machine. For an HTML
  file, the review server can load only that file's parent directory and its
  subdirectories. Embed assets in the HTML or place them within that boundary.
  For a running page, use a URL on one loopback origin, such as
  `http://localhost:3000/page`. The review server proxies requests to that
  origin, including assets, APIs, and WebSockets, and preserves client
  rerenders.

## Launch

Choose a new output path in a temporary directory. Inspect live help:

```bash
SCRIPT="<skill-directory>/scripts/html_review.mjs"
node "$SCRIPT" --help
```

For a file:

```bash
node "$SCRIPT" /absolute/path/to/page.html --async \
  --output /absolute/path/to/result.json
```

For an already-running loopback page:

```bash
node "$SCRIPT" http://localhost:3000/page --async \
  --output /absolute/path/to/result.json
```

Each new invocation starts with zero comments. Use `--restore-comments` only
when the user explicitly asks to recover comments from an interrupted review;
never use it to preload previously submitted feedback. Use a new output path:

```bash
node "$SCRIPT" /absolute/path/to/page.html --async \
  --output /absolute/path/to/new-result.json \
  --restore-comments /absolute/path/to/prior-result.draft.json
```

For an output named `result.json`, the tool reports these paths:

- `result.json` — the submitted feedback; created only after **Send**
- `result.draft.json` — autosaved comments for recovery
- `result.log` — worker diagnostics

Record the reported paths, then end the turn while the user reviews the page.
Do not poll or keep the worker attached. Browser activity does not resume the
conversation; the user must send another chat message.

## Resume

- **Feedback sent:** Check the submission file once. If it is missing, inspect
  the log once and report the failure.
- **Browser closed or crashed:** Recover the draft only if the user explicitly
  asks. Identify recovered comments as autosaved, not submitted.
- **Review cancelled:** Do not recover the draft unless the user asks.

## Return

- Return every comment with its target data intact.
- Address the comments once submitted.
