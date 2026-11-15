---
name: auto-skill-loop
description: >-
  Run an autonomous loop intended to result in merged PRs.
disable-model-invocation: true
compatibility: Requires dispatch-agent, implement, ship-pr, the Agent Dispatch MCP dispatch_start/inspect/wait/output/continue/cancel contract, and named operator, planner, plan_reviewers, implementer, code_reviewer, pr_worker, and rote_worker targets. Issue/backlog modes use docs/agent-layer project memory conventions.
---

# auto-skill-loop

Each iteration implements one PR's worth of work, ships it, and merges it under
the gate below. Run iterations until the user stops the loop or two consecutive
iterations find no work. Report each iteration's outcome as a progress update;
do not end the turn or ask whether to continue.

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

- Use `/dispatch-agent` for every dispatch. Act as the orchestrator; delegate
  all work.
- Build each dispatch prompt only as specified below.
- A dispatch is finished only when its final reply contains the outcome named
  for its step, a question, or a blocker. On any other reply, such as a status
  report or pending monitoring, continue the same session:
  `Continue the <skill> workflow until you return <outcome>.`
- When compacting, retain the original user inputs and this skill verbatim in
  addition to what you would normally retain.

## Human Input

The loop runs without human intervention. When a dispatch returns a question or
a blocker, dispatch `operator` in a fresh session with the complete contents of
`references/human-guidance.md`, then `operator_context` if provided, then the
question or blocker verbatim. Continue the asking session with the answer.

If the operator determines that a real human must decide, continue the asking
session to push its work to a remote branch, leave any PR open and unmerged,
and return to the primary branch. Then return to step 1.

## Loop

1. Dispatch `planner` with skill `implement`:

```text
<complete contents of references/modes/<mode>.md>
<planner_context, if provided>

implementer: <implementer>
plan_reviewers: <plan_reviewers>
code_reviewer: <code_reviewer>

Exclude work covered by an open PR or an unmerged remote branch, and pass this
exclusion to any discovery subagent. If no qualifying work remains, or current
evidence shows diminishing returns, return only `No work: <reason>` and
implement nothing. Otherwise return a self-contained `<implementation_input>`
that states the actual task, request, or spec you implemented and includes
paths to plan artifacts if used.
```

Outcome: `<implementation_input>` or `No work`. Count a reply that reports
diminishing returns as `No work`, after shipping any work it implemented. Two
consecutive `No work` outcomes end the loop; report both reasons.

2. Dispatch `rote_worker` with skill `ship-pr`:

```text
pr_worker: <pr_worker>
<ship_pr_context, if provided>

Use the following context to preserve intended scope and behavior throughout the PR
workflow:

<implementation_input>
```

Outcome: a merge-authorization request for an exact PR and head.

3. Dispatch `operator` in a new session with the complete contents of
   `references/merge-authorization.md`, then:

```text
<operator_context, if provided>
request: <rote_worker merge-authorization request>
```

Outcome: authorized, or denied with a reason.

4. Continue the step 2 session with the exact authorization or the denial
   reason. Outcome: the PR merged and cleaned up on the primary branch, or a
   fresh merge-authorization request; for the latter, return to step 3. A
   repeated denial for the same reason is a blocker. After the merge, return
   to step 1 in the same run.
