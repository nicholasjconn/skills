---
name: implement
description: >-
  Implement a large, substantive code change directly or through a planned
  cross-agent workflow, adding plan or code review only when warranted.
---

# implement

## Inputs

Use the task or spec as `<input>`. For a delegated stage, use `/dispatch-agent`
with the supplied target for that role. Report missing targets or dispatch
capabilities when the selected stage needs them.

## Decide Implementation Approach

Inspect the relevant architecture. Reuse existing code and established patterns
when they fit `<input>`. Resolve substantive requirements and tradeoffs before
implementation.

Planning and independent review add significant cost. Before implementation,
answer each question yes or no:

- Is a written plan required to confidently complete and verify `<input>`?
- If a plan is required, does its material risk or complexity justify
  independent plan review?
- Does the implementation's material risk or complexity justify independent
  code review, whether implementation is direct or planned?

If no plan is required, implement `<input>` directly, run targeted checks, and
continue to Finish.

## Implementation with a Written Plan

Write a self-contained plan with the context needed to execute it and a
checklist for verifying completion.

If independent plan review is required, dispatch all `plan_reviewers`
concurrently with self-contained prompts to review the plan against `<input>`
without editing files. Address valid in-scope findings. Review the plan once.

Dispatch `implementer` to execute the plan, run targeted checks, and return
after completion. Tell it to implement directly without invoking this skill
or dispatching another implementer.

Check completion against `<input>` and the plan. If the implementation
is incomplete, call `dispatch_continue` once with the `implementer` session
handle and a prompt listing the unmet requirements and instructing it to
complete the plan before returning. If implementation remains incomplete after
that continuation, use a fresh dispatch whose prompt includes the original
plan, current implementation state, and remaining work. Repeat the instruction
not to invoke the `implement` skill or dispatch another implementer in the
fresh prompt. If the continuation did not make meaningful progress, detail a
different approach in that prompt.

## Finish

1. Inspect and simplify the implementation without changing required behavior
   or broadening the task. Remove unnecessary complexity, duplication, dead
   code, premature abstractions, and tests that cannot detect a product defect.

2. If independent code review is required, dispatch `code_reviewer` to review
   the implementation against `<input>` and any plan without editing
   files. Evaluate each finding and fix those that are valid within `<input>`'s
   scope. Check findings related to explicit requirements against `<input>`
   before rejecting them. If the fixes are substantial, perform one fresh final
   review.

3. Check completion against `<input>` and any plan. Resolve
   gaps until it passes. Passing tests are supporting evidence, not proof of
   completion.

4. Ensure the exact final tree has passed the repository's required verification.
   Reuse valid results only for that tree; run remaining required checks.
   After a fix, apply the same rule to the updated tree and confirm the fix.
