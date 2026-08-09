---
name: pr-retrospective
description: >-
  Score one or more merged GitHub PRs after review and post a structured
  retrospective JSON comment on each. Use when the user asks to assess PR
  value, correctness, risk control, code health/debt, verification, and
  strategy. Do not use for normal code review, CI repair, or shipping an active
  PR.
---

# pr-retrospective

Review merged GitHub PRs and post machine-readable retrospective comments.

## Scope

- Accept one PR (`612`, `#612`, or URL), a comma-separated list, an inclusive
  range (`601-614`), a mix, or no PR input.
- A PR is eligible only when its metadata has a non-null `mergedAt`.
- With explicit input, de-duplicate the requested PRs and inspect their metadata.
  Record unmerged PRs as `skipped-unmerged` in `summary.md`. Process only
  eligible PRs, sorted by `mergedAt` from oldest to newest.
- With no input, scan recent merged PRs by `mergedAt` from newest to oldest.
- During backfill, pause after fully reviewing 20 eligible PRs without markers
  and ask the user or caller whether to continue before reviewing another.
  Marker-skipped and unscorable PRs do not count. State the last reviewed PR.

## Output

Set `run-id` to `YYYYMMDD-HHMMSS-<short-rand>` and write these files under
`.agent-layer/tmp/`:

- `pr-retrospective.<run-id>.scores.jsonl` - one line per scored PR with `pr`,
  `url`, `scores`, `summary`, and `comment_file`.
- `pr-retrospective.<run-id>.pr-<number>.md` - one comment body per scored PR.
- `pr-retrospective.<run-id>.summary.md` - evidence, outcomes, posted comment
  URLs, and the final score table.

## Contract

- Score keys are exactly `value`, `correctness`, `risk_control`, `code_health`,
  `verification`, and `strategy`. Each is an integer from 1 to 10; higher is
  better.
- Match `Comment format` exactly: the marker and fenced JSON, with no extra
  fields or Markdown in string values. Keep `summary` to one concise sentence.
- Use the title, body, and linked issues to establish the intended outcome.
  Judge delivery from the diff, tests, checks, and reviews, not author claims.
  Do not penalize diff size by itself.
- If a later PR fixed a defect, mention that in `summary`.
- Do not invent facts. If the diff, checks, reviews, or metadata cannot be read,
  record the gap and skip the PR.

## Comment format

Each PR comment body must be exactly:

````markdown
<!-- agent-panel-pr-retrospective:v4 -->
```json
{
  "type": "pr_retrospective_score",
  "schema_version": 4,
  "scale": {
    "min": 1,
    "max": 10,
    "higher_is_better": true
  },
  "scores": {
    "value": 3,
    "correctness": 4,
    "risk_control": 2,
    "code_health": 9,
    "verification": 6,
    "strategy": 2
  },
  "summary": "Low-value stale-client work was cleanly implemented but used a poor strategy, left the normal projects view incomplete, and exposed users to unreliable self-update behavior."
}
```
````

## Evidence

Prefer local `git` and `gh`; use `gh --help` for non-obvious commands. If `gh`
is unavailable, use a GitHub connector or stop and report the problem.

Gather enough evidence to justify every score:

- metadata: title, body, state, merge status, author, dates, branches,
  additions/deletions, changed files, labels, linked issues, and URL
- the diff, tests added or changed, CI/check results, and review or issue
  comments, including bot-reported defects
- current code only when needed to confirm whether a suspected defect remains
- `ISSUES.md` for known deferred debt

## Rubric

Score each key independently. Within a band, use the higher number when the
result more closely matches the band's upper end.

- **value** - user/operator/team benefit delivered. `9-10` major benefit,
  release unblocker, or high-leverage foundation; `7-8` substantial benefit to
  an important workflow or audience; `5-6` useful but narrow, incremental, or
  internal benefit; `3-4` small, uncertain, or rarely realized benefit; `1-2`
  little or no realized benefit.
- **correctness** - whether the merged behavior satisfies its requirements.
  `9-10` fully correct across important paths and failures, with no known
  material defects; `7-8` core behavior correct with minor limitations; `5-6`
  mostly correct with a meaningful noncritical gap; `3-4` important behavior
  missing or incorrect; `1-2` fundamentally broken, regressive, or unable to
  meet its objective.
- **risk_control** - security, reliability, data-safety, and operational risk
  reduced or contained. `9-10` removes serious risk or fully controls major new
  exposure; `7-8` materially reduces risk or controls meaningful new exposure;
  `5-6` is risk-neutral or leaves limited, justified exposure with adequate
  controls; `3-4` leaves meaningful exposure with weak controls; `1-2`
  introduces or conceals serious risk.
- **code_health** - maintainability, ownership, duplication, and complexity.
  `9-10` simplifies ownership, removes debt, and strengthens clear sources of
  truth; `7-8` clean and maintainable with minor complexity or debt; `5-6`
  acceptable but adds noticeable complexity, duplication, or partial ownership;
  `3-4` brittle or confusing with substantial avoidable debt; `1-2` a major
  code-health regression or deeply unsustainable design.
- **verification** - confidence from tests, checks, and review response. `9-10`
  targeted behavioral tests cover key paths and failures, CI passes, and review
  concerns are resolved; `7-8` strong evidence with one minor meaningful gap;
  `5-6` partial tests or CI provide moderate confidence; `3-4` weak or indirect
  evidence leaves important behavior untested; `1-2` no meaningful evidence,
  self-confirming tests, failing required checks, or unresolved review concerns.
  Credit only tests that would fail for a realistic defect, including the
  user-facing integration path.
- **strategy** - quality of the chosen plan, independent of execution. Assume
  perfect execution. `9-10` targets the right problem and root cause with the
  right mechanism, ownership layer, and scope; `7-8` sound strategy with a minor
  scope or placement compromise; `5-6` viable but indirect, overbroad,
  under-scoped, or mixed with unrelated concerns; `3-4` treats symptoms or
  creates avoidable structural problems; `1-2` solves the wrong problem or uses
  a fundamentally unsuitable strategy.

## Workflow

1. Resolve and echo the target repo; confirm `gh auth status`; create the
   artifact files; resolve targets according to `Scope`.
2. Before reading a diff, inspect each candidate PR's comments for an
   `agent-panel-pr-retrospective:v1`, `agent-panel-pr-retrospective:v2`,
   `agent-panel-pr-retrospective:v3`, or `agent-panel-pr-retrospective:v4`
   marker.
   - If a marker exists, record the PR as skipped unless the user explicitly
     requested a duplicate. Never edit, replace, or delete an existing comment.
   - During backfill, increment the consecutive-marker counter for an eligible
     PR with a marker. Stop when it reaches two.
   - An eligible PR without a marker resets the counter, even if it later proves
     unscorable.
3. For each eligible PR not skipped in step 2, gather `Evidence`, read the
   changed code paths, and check whether later PRs changed the reviewed behavior.
   Record notes in `summary.md` before scoring.
4. Score each key against the `Rubric`, calibrating across PRs when a range is
   given. Write the `pr-<number>.md` body using the exact `Comment format`,
   append the `scores.jsonl` line, and parse the fenced JSON to validate it.
5. Run `gh pr comment <number> --body-file <comment_file>` for each scored PR.
   Posting is part of the skill even when the user did not explicitly request
   it. Record the posted comment URL in `summary.md`.

## Finish

Report the target repo, processed and skipped PRs, skip reasons, artifact paths,
posted comment URLs, and the backfill stop condition. Include a compact table
with `PR`, `value`, `correctness`, `risk_control`, `code_health`, `verification`,
and `strategy`.
