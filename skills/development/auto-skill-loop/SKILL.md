---
name: auto-skill-loop
description: >-
  Run an autonomous loop intended to result in merged PRs.
disable-model-invocation: true
compatibility: Requires dispatch-agent, implement, ship-pr, the Agent Dispatch MCP dispatch_start/inspect/wait/output/continue/cancel contract, and named operator, planner, plan_reviewers, implementer, code_reviewer, pr_worker, and rote_worker targets. Issue/backlog modes use docs/agent-layer project memory conventions.
---

# auto-skill-loop

Prerequisites: Requires dispatch-agent, implement, ship-pr, the Agent Dispatch MCP dispatch_start/inspect/wait/output/continue/cancel contract, and named operator, planner, plan_reviewers, implementer, code_reviewer, pr_worker, and rote_worker targets. Issue/backlog modes use docs/agent-layer project memory conventions. Missing dispatch capabilities must be reported; tracked skill content can advance independently of the installed CLI.

Continue across PRs until the user stops the loop or step 1 reaches an exit
condition. A merged PR or a worker's final reply does not complete the loop.
Report iteration outcomes as progress updates without ending the turn or asking
whether to continue.

## Inputs

Required:

- a `mode` matching `references/modes/<mode>.md`
- `merge_authorization`: standing authorization to merge under the gate below
- `operator`, `planner`, one or more `plan_reviewers`, `implementer`, `code_reviewer`,
  `pr_worker`, and `rote_worker` dispatch targets

Optional:

- `loop_context`: additional context for the orchestrator only
- `planner_context`: additional context included only in step 1
- `ship_pr_context`: additional context included only in step 2
- `operator_context`: additional context included only in `operator` dispatches

Every input must be explicitly named in the skill invocation. Do not infer an
unnamed input from unstructured text or from another input.

## Rules

- Use `/dispatch-agent` for every dispatch.
- Act as the orchestrator. Delegate all work.
- Build dispatch prompts from the templates and continuation directions below.
- When compacting, retain the original user inputs and this skill verbatim in
  addition to what you would normally retain.
- Follow `/dispatch-agent` termination safeguards: require
  `termination_confirmed: true` before continuing, advancing, or replacing; never
  replace active work or start discovery from unconfirmed state.
  Monitor active or unconfirmed invocations with wait/inspect; cancel only when
  the user or an active skill instruction authorizes abandonment, never merely
  to advance after progress. Cancellation is not termination proof; if monitoring
  cannot confirm termination, report a blocker and stop the loop.
- Keep an inventory of every PR opened or touched and pre-PR preserved work:
  PR URL once one exists, exact branch, last full head SHA, one-line scope, repair
  rounds used, resumes used, and state: `open` (being shipped), `preserved`
  (needs-human, substantive refusal, repair bound exhausted, re-preserved, or
  blocker), or `merged`. Update at each handoff; mark repeat preservation
  re-preserved. Include in every planner prompt and retain with counters/evidence
  across iterations and compaction. Keep branch-only entries in later
  reconciliation; never create placeholder PRs.
- After a terminal planner/worker result with `termination_confirmed: true`,
  a status-only reply (including waiting on CI/reviews) or incomplete outcome
  is unfinished: continue the SAME session, refetch fresh GitHub/repository
  state, and resume monitoring. Only absent required reviewer feedback stalls
  after ship-pr's review deadline; pending checks stall only after 60 minutes
  without a check state change. After two consecutive no-progress continuations,
  continue once to preserve as a blocker; if unconfirmed, report and stop.

## Acting on the User's Behalf

This loop must run without human intervention. Each iteration is intended to result
in a merged PR. For each loop that requires human input, dispatch `operator` in
a fresh session. Use `dispatch_continue` for multiple invocations within a
single loop. The first prompt should include the complete contents of
`references/human-guidance.md`, followed by `operator_context` if provided, then
the item requiring human input with all provided details verbatim.

If the `operator` determines that real human intervention is required, save the
work to an appropriate remote branch for future handling, then check out the
primary branch. Continue with another loop iteration. Do not block the loop
waiting for human input.

## Loop

1. Dispatch `planner` with skill `implement`. Use the following as its prompt:

```text
<complete contents of references/modes/<mode>.md>
<planner_context, if provided>
Run PR inventory: <complete inventory, or none yet>

implementer: <implementer>
plan_reviewers: <plan_reviewers>
code_reviewer: <code_reviewer>

Forward the inventory and a current open-PR snapshot to any delegated discovery
worker to exclude overlapping work except permitted resumes below.
Before implementing, avoid inventory/open-PR overlap except permitted resumes.
If all candidates are excluded, return no-work citing those entries. Resume other
preserved work once per run, only when its reason no longer applies and no human
decision is pending; reuse it and report evidence. If preserved again, mark
re-preserved and non-resumable for this run. Repair bound exhaustion or substantive
refusal also prevents resumption without new human direction.

Return exactly one typed outcome:
- ready: self-contained `<implementation_input>` stating the task/request/spec
  implemented, plan artifact paths if used, and reconciliation evidence.
- no-work: fresh open-PR/inventory evidence that no independent work qualifies.
- blocker: new blocker reason, remote branch/full head/scope, and confirmation
  that blocked work was pushed and primary is checked out clean.
```

Before step 2, reject `ready` overlapping a different open PR or non-resumable
inventory entry by branch or scope; continue the SAME planner with inventory and
exclusion evidence to select other work under the unfinished-handoff bound.
On `blocker`, return to step 1 after preservation.
Two consecutive typed `no-work` outcomes exit; report both evidences.
Repeat step 1 after the first; `ready` or a new `blocker` resets the count. A
`blocker` merely re-reporting an existing preserved entry does not reset it.
Diminishing-returns prose that selects work is not `no-work`.
Exit and report on the second consecutive step 1 outcome with the SAME unchanged
systemic blocking cause and no progress; distinct causes or progress reset it.

2. Dispatch `rote_worker` with skill `ship-pr` and this prompt:

```text
pr_worker: <pr_worker>
<ship_pr_context, if provided>

Use the following context to preserve intended scope and behavior throughout the PR
workflow:

<implementation_input>

Return one typed outcome with PR URL (if any), branch, and full current head SHA:
ready (exact PR/head merge-authorization request with ship-pr readiness evidence)
or blocker (reason and confirmed preservation/return to primary).
After authorization, return merged-and-cleaned-up,
preserved-and-returned-to-primary, or a fresh ready request, with evidence.
```

Advance to step 3 only on `ready`; on `blocker`, return to step 1 after
preservation.

3. Dispatch `operator` in a new session. Use the complete contents of
`references/merge-authorization.md` as its prompt, then append:

```text
<operator_context, if provided>
request: <rote_worker merge-authorization request>
```

No verdict is not a denial: after confirmed termination, retry step 3 once
in a new operator session; if still no authorized/denied verdict, preserve as a
blocker under step 4.

4. If authorized, continue the step 2 session with its single-use authorization
for that exact PR/full head SHA and ship-pr's post-authorization checks. Lock
the merge to that full SHA, e.g.
`gh pr merge --match-head-commit <authorized full SHA>`, or equivalent. Any
head change invalidates it; if refetch finds anything changed (including new
eligible comments at the same head), do not merge: return a fresh `ready` request.
ANY fresh `ready` request returns to step 3 in a NEW operator session. A stale
head alone requires a fresh request; neither that nor a post-authorization
re-request is a repair round. Never self-authorize.

If all denial reasons are `repairable-process`, continue the SAME worker with
the classified reasons to repair through ship-pr without scope changes or human
decisions and return a fresh `ready` request. One repair round is one repair
continuation after a denial; allow two per PR across the run, then preserve if
still denied.

For any `substantive-refusal` or unclassified denial, preserve without further
PR mutation or replies; never re-ask for authorization. On refusal, repair
exhaustion, or blocker, direct the same worker to save existing work and
return to the primary branch without merging.

5. For `merged-and-cleaned-up`, require evidence that the merged PR head equals
the authorized full SHA; otherwise report a blocker and stop. On verified merge
or `preserved-and-returned-to-primary`, update inventory and return to step 1.
