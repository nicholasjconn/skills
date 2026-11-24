---
name: implement
description: >-
  Implement substantive code changes with optional planning, delegation, and
  independent review.
---

# implement

## Inputs

Use the task or spec as `<input>`. Before a delegated stage, verify the supplied
role target and the dispatch capabilities that stage needs. Report any gaps.
Use `/dispatch-agent` with the supplied target. Give each delegate the full
requirements for its assignment and relevant context, inline or in files it can
read from its checkout.

## Decide Implementation Approach

Inspect the relevant architecture. Reuse existing code and established patterns
when they fit `<input>`. Resolve substantive requirements and tradeoffs before
implementation.

Before implementation, weigh the cost of each step against the benefit it adds.
Decide separately:

- Is a written plan required to confidently complete and verify `<input>`?
- If a plan is required, does its material risk or complexity justify
  independent plan review?
- Would a separate implementer add enough value to justify the handoff?
- Does the implementation's material risk or complexity justify independent
  code review?

A written plan can guide direct implementation.

## Planning

If writing a plan, include implementation context and how to verify each
requirement.

If independent plan review is required, dispatch each `plan_reviewers` target
once, concurrently. Ask for findings only, comparing the plan against
`<input>`. Update the plan with accepted findings before implementation.

## Implementation

### Direct

Implement `<input>` using any plan. Run targeted checks and resolve gaps before
continuing to Finish.

### Delegated

Dispatch `implementer` with the full `<input>`, resolved decisions, and any
current plan. Ask it to complete the task and run targeted checks before
returning. Tell it to implement directly without invoking this skill or
delegating again.

Check completion against `<input>` and any plan. If gaps remain, resume the
`implementer` once with `dispatch_continue`, listing the unmet requirements.
If that leaves gaps, make one fresh dispatch with the original requirements,
resolved decisions, any current plan, the implementation state, and the
remaining work. Repeat the direct-work instruction and give a different
approach if the continuation stalled. Resolve any remaining gaps directly.

## Finish

1. Inspect and simplify the implementation without changing required behavior
   or broadening the task. Remove unnecessary complexity, duplication, dead
   code, premature abstractions, and tests that cannot detect a product defect.

2. If independent code review is required, dispatch `code_reviewer` to review
   the implementation against `<input>` and any plan without editing
   files. Evaluate each finding and fix those that are valid within `<input>`'s
   scope. Check findings related to explicit requirements against `<input>`
   before rejecting them. If substantial fixes justify another review, run at
   most one follow-up review.

3. Check completion against `<input>` and any plan. Resolve
   gaps until it passes. Passing tests are supporting evidence, not proof of
   completion.

4. Ensure the exact final tree has passed the repository's required verification.
   Reuse valid results only for that tree; run remaining required checks.
   After a fix, apply the same rule to the updated tree and confirm the fix.
