---
name: auto-skill-loop
description: >-
  Run an autonomous loop intended to result in merged PRs.
disable-model-invocation: true
compatibility: Requires dispatch-agent, implement, ship-pr, the Agent Dispatch MCP dispatch_start/inspect/wait/output/continue/cancel contract, and named operator, planner, plan_reviewers, implementer, code_reviewer, pr_worker, and rote_worker targets. Issue/backlog modes use docs/agent-layer project memory conventions.
---

# auto-skill-loop

Prerequisites: Requires dispatch-agent, implement, ship-pr, the Agent Dispatch MCP dispatch_start/inspect/wait/output/continue/cancel contract, and named operator, planner, plan_reviewers, implementer, code_reviewer, pr_worker, and rote_worker targets. Issue/backlog modes use docs/agent-layer project memory conventions. Missing dispatch capabilities must be reported; tracked skill content can advance independently of the installed CLI.

Continue across PRs until the user stops the loop or step 1 reaches its no-work
exit condition. A merged PR or a worker's final reply does not complete the loop.
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
- Keep an inventory of every PR opened or touched: URL, branch, last full head
  SHA, one-line work summary, and state `open` (being shipped), `preserved`
  (needs-human, substantive refusal, repair bound exhausted, or blocker), or
  `merged`. Update it at each handoff, include it in every planner prompt,
  and retain it and counters/evidence across iterations and compaction.
- Planner/worker status-only replies (including waiting on CI/reviews) or
  incomplete outcomes are unfinished: continue the SAME session from fresh
  state and resume monitoring; after two consecutive continuations without
  concrete progress, continue once to preserve as a blocker. If preservation
  is unconfirmed, report the blocker and stop.

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

Before implementing, reconcile selected work with this inventory and the
repository's currently open PRs; choose non-overlapping work or report
no-work/blocker. Resume a preserved PR only when its reason no longer applies
and no human decision is pending; reuse it and report evidence. Never reopen
a substantive refusal without new human direction.

Return exactly one typed outcome:
- ready: self-contained `<implementation_input>` stating the task/request/spec
  implemented, plan artifact paths if used, and reconciliation evidence.
- no-work: evidence that no qualifying, non-duplicate work remains.
- blocker: reason and preservation location; blocked work is not no-work.
```

Only `ready` advances to step 2; `blocker` returns to step 1 after preservation.
Only two consecutive typed `no-work` outcomes exit; report both evidences.
Repeat step 1 after the first; `ready`/`blocker` resets the count.
Diminishing-returns prose that selects work is not `no-work`.

2. Dispatch `rote_worker` with skill `ship-pr` and this prompt:

```text
pr_worker: <pr_worker>
<ship_pr_context, if provided>

Use the following context to preserve intended scope and behavior throughout the PR
workflow:

<implementation_input>

Return one typed outcome with PR URL, branch, and full current head SHA: ready
(exact PR/head merge-authorization request with ship-pr ledger/readiness
evidence) or blocker (reason and confirmed preservation/return to primary).
After authorization, return merged-and-cleaned-up or
preserved-and-returned-to-primary with evidence.
```

Advance to step 3 only on `ready`; on `blocker`, return to step 1 after
preservation.

3. Dispatch `operator` in a new session. Use the complete contents of
`references/merge-authorization.md` as its prompt, then append:

```text
<operator_context, if provided>
request: <rote_worker merge-authorization request>
```

4. If authorized, continue the step 2 session with the exact authorization and
ship-pr's post-authorization checks. It authorizes only that PR/full head SHA;
any head change (including repair commits) invalidates it: obtain a fresh
request and repeat step 3 in a NEW operator session. Never self-authorize.

If all denial reasons are `repairable-process`, continue the SAME worker with
the classified reasons to repair through ship-pr without scope changes or
human decisions and return a fresh `ready` request. Allow two rounds per PR for
the whole run, then preserve if still denied; repeat step 3 after each repair
in a NEW operator session, even with an unchanged head.

For any `substantive-refusal` or unclassified denial, preserve without further
PR mutation or replies; never re-ask for authorization. On refusal, repair
exhaustion, or blocker, direct the same worker to save existing work and
return to the primary branch without merging.

5. Wait for `merged-and-cleaned-up` or `preserved-and-returned-to-primary` with
evidence, update the inventory with state and preservation reason, then
immediately return to step 1 in the same run.
