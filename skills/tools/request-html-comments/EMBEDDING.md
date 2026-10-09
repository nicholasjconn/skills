# Embedding the review engine

`review_geometry.js` and `review_overlay.js` are the shared browser engine.
Evaluate them together in a private scope, in that order, then call
`createHtmlReview(options)` once per top-level page. Bundlers may wrap the
concatenated sources and export the factory. Keep consumer snapshots pinned to
an upstream commit, preserve the attribution and license, and update the
snapshot without editing the copied engine independently.

Supply persistence and completion behavior through the adapters below rather
than rewriting the engine or forking its targeting logic.

Required options:

- `saveDraft({ comments, deleted_ids })`: persist an idempotent patch. Throw or
  reject on failure. Comment records contain text/element targets, timestamps,
  IDs, and iframe/shadow paths; preserve them intact.
- `onFinish(action, api)`: handle `submit` or `cancel`. The engine locks review
  interaction and flushes pending changes first. The host decides whether to
  download or navigate. Successful completion runs once and hides the toolbar,
  comment pins, highlights, and editor; failures unlock the UI for retry.
  Comments remain available through `getComments()`. Call `resume()` after
  completion to explicitly start another review cycle.

Optional options:

- `initialComments`: explicitly restored comment records, default empty.
- `flushOnPageHide(patch)`: synchronous browser storage or a beacon/keepalive
  transport. Without it, `saveDraft` is used; the browser may not await promises
  during unload.
- `submitLabel`, `closeLabel`: toolbar accessible names and labels. `submitIcon`
  replaces the decorative submit glyph with plain text. `submitIconOnly` hides
  the visible label while preserving the accessible name and tooltip.
- `requireSavedComment`: default true; false allows submitting partially typed
  comments.
- `submitRequiresPersistence`: default true. A download-only host can set false
  so storage failure does not prevent exporting the in-memory comments. The
  failure remains visible.
- `actions`: `{ label, run(api) }` toolbar actions. The engine flushes before
  invoking an action and displays errors.

Comment records include `page_url` (the top page's path, query, and fragment)
and `page_title`. Pins and text highlights appear only at the matching URL,
including after single-page-app navigation. Ordinary section anchors therefore
identify distinct annotation views. Older comments without `page_url` remain
visible across views. Preserve these fields when storing or exporting comments.

The overlay supports the top document and nested same-origin frames, including
frames in open shadow roots. Comment records preserve `iframe_path` through
multiple levels. Frame geometry supports ordinary and axis-aligned
scale/translation layouts; rotated, skewed, or 3D frame ancestry is unsupported.
Cross-origin, opaque-origin, and closed-shadow-root frames cannot be annotated.

The returned API provides:

- `getComments()`: a detached snapshot, including nonempty text in the current
  editor.
- `flush()`: persist pending comments, including unfinished text.
- `suspend()`: flush, hide the tool and pins, and exit selection mode without
  discarding the editor. Rejects if persistence fails.
- `resume()`: show the existing tool and editor and allow another completion;
  does not create a second instance. Call after `onFinish` has returned, not
  while completion is in progress.
- `clearComments()`: clear the in-memory comments, editor, and pins after the
  host has archived the review and cleared its stored draft. Flush pending
  persistence first; this method does not write storage.
- `addComment(record)`: add a recovered comment with a new unique ID; call
  `flush()` before reporting recovery as saved.

Suspend/resume is for a single mounted page. Reuse that instance for navigation
within a single-page app; do not repeatedly create factories. The host owns
navigation after completion and the exported-file format.

The engine wraps `history.pushState`/`replaceState` and observes `popstate` and
`hashchange`; routers must call the current methods for marker updates.
