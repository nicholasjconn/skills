# Validation and recovery

## Validation

Validate representative targets through the overlay before handoff. With
`--no-open`, check that a temporary comment records the intended target and,
where applicable, its nested iframe path. Transformed, adopted, iframe-based,
or dynamic surfaces may matter when reproducing the problem. Cancel that
review, close the automation browser, then open one fresh user-facing review
with a new output path.

## Recovery

For requested recovery, use `--restore-comments` with a new output path:

```bash
node "<skill-directory>/scripts/html_review.mjs" /absolute/path/to/page.html --async \
  --output /absolute/path/to/new-result.json \
  --restore-comments /absolute/path/to/prior-result.draft.json
```
