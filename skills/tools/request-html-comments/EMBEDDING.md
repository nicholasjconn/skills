# Embedding the review engine

`review_geometry.js` and `review_overlay.js` are the shared browser engine. Evaluate them together in a private scope, in that order, then call `createHtmlReview(options)` once per top-level page. No server, global geometry helper, or runtime dependency is required. Bundlers may wrap the concatenated sources and export the factory. Keep the upstream attribution and license when distributing a pinned snapshot.

The local CLI composes the same engine with `review_local.js`, which owns HTTP requests and the completion page. Hosts should not intercept `fetch`, rewrite the overlay source, or fork its targeting logic.

Required options:

- `saveDraft({ comments, deleted_ids })`: persist an idempotent patch. Throw or reject on failure. Comment records contain text/element targets, timestamps, IDs, and iframe/shadow paths; preserve them intact.
- `onFinish(action, api)`: handle `submit` or `cancel`. The engine locks review interaction and flushes pending changes first. The host decides whether to download, navigate, or hide the tool. Successful completion runs once; failures unlock the UI for retry. Call `resume()` after completion to explicitly start another review cycle.

Optional options:

- `initialComments`: explicitly restored comment records, default empty.
- `flushOnPageHide(patch)`: synchronous browser storage or a beacon/keepalive transport. Without it, `saveDraft` is used; the browser may not await promises during unload.
- `submitLabel`, `closeLabel`: toolbar accessible names and labels. `submitIcon` replaces the decorative submit glyph with plain text. `submitIconOnly` hides the visible label while preserving the accessible name and tooltip.
- `requireSavedComment`: default true; false allows submitting partially typed comments.
- `submitRequiresPersistence`: default true. A download-only host can set false so storage failure does not prevent exporting the in-memory comments. The failure remains visible.
- `actions`: `{ label, run(api) }` toolbar actions. The engine flushes before invoking an action and displays errors.

The returned API provides:

- `getComments()`: a detached snapshot, including nonempty text in the current editor.
- `flush()`: persist pending comments, including unfinished text.
- `suspend()`: flush, hide the tool and pins, and exit selection mode without discarding the editor. Rejects if persistence fails.
- `resume()`: show the existing tool and editor and allow another completion; does not create a second instance. Call after `onFinish` has returned, not while completion is in progress.
- `clearComments()`: clear the in-memory comments, editor, and pins after the host has archived the review and cleared its stored draft. Flush pending persistence first; this method does not write storage.
- `addComment(record)`: add a recovered comment with a new unique ID; call `flush()` before reporting recovery as saved.

Suspend/resume is for a single mounted page. Listeners remain installed to support same-origin iframe navigation; do not repeatedly create factories in a single-page app. Local CLI defaults and explicit `--restore-comments` behavior are unchanged. Browser history, provenance, identity, and exported-file schemas belong to the host adapter.
