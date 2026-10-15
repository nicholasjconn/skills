---
name: write-procedure
description: Create or substantially rewrite an agent-facing skill, procedure, or guide, then refine it through a user-selected multi-agent clarity review. Use when the user asks for this review loop or needs an instruction document made concise, complete, and unambiguous. Do not use for ordinary documentation, code review, or a small wording edit.
---

# Write Procedure

Create an instruction file that a capable agent can follow without guessing. The
main agent writes the file and decides which reviewer suggestions improve it.

## Required input

The user must name one or more review agents. Use the current client's built-in
subagent tool for reviewers it supports. Use `dispatch-agent` for named external
providers. Ask the user if no reviewer is named or a reviewer cannot be mapped to
one of those mechanisms.

## Understand the instruction boundary

For a skill, follow the current
[Agent Layer skill-design guide](https://github.com/conn-castle/agent-layer/blob/main/docs/SKILL-DESIGN.md).
Determine:

- when and why the target file is loaded;
- what inputs, context, tools, and output contracts the agent receives elsewhere;
- which behavior this file owns; and
- which files own supporting policy or mechanics.

Inspect loaders, callers, and routed references that define the target's context.

Fix a related ownership problem only when it is necessary for the requested
document and within the user's authorized scope; otherwise report it.

## Write cohesively

Produce one cohesive document rather than a collection of review patches:

- Write for a capable agent. Keep task-specific context, non-obvious constraints,
  tool requirements, and completion criteria; omit generic reminders.
- Use plain words and short sentences. Explain each section's purpose and when
  it applies before giving details.
- Remove redundancy while preserving context and meaningful behavioral
  distinctions.
- Keep always-loaded instructions minimal and detailed guidance on demand.
  Route to supporting files only when they change execution, and say when each
  one should load.
- Keep rules in one canonical owner. Point to existing rules, runtime schemas,
  code, and CLI help instead of duplicating them.
- Treat length as a review signal, not a reduction target. Remove unnecessary
  reading, generic advice, and process without sacrificing useful information.

## Validate before review

Use existing checks that can expose a real defect:

- For a skill, check its frontmatter, name, description, and size against the
  current skill-design guidance.
- For a procedure loaded into an agent prompt at runtime, run the focused loader
  or prompt-assembly test when one exists.
- For a guide, verify the paths and links affected by the change and run any
  existing documentation check.

## Independent review

Invoke every reviewer through the mapping established before drafting. Use the
`dispatch-agent` skill for dispatch targets.

Give every reviewer the exact current contents and an identical description of
the target's actual load-time context: its purpose, when it loads, inputs supplied
elsewhere, runtime-owned contracts, and routed references. Include the contents
in a native reviewer's prompt. For dispatch, either include them in the prompt or
write a new per-round prompt file in the repository's documented temporary or
scratch directory and submit that file.

Tell each reviewer to work read-only, make no edits, avoid consulting other
reviewers, and answer directly. State that the supplied load-time context is
authoritative, the document is for a capable agent, and rules owned elsewhere
should not be duplicated.

Require each reviewer to answer these questions directly, beginning every answer
with `Yes` or `No`:

1. Does this file give you the information you need without leaving you guessing
   what anything means?
2. Is it clear what you should do when provided inputs?
3. Is it written unambiguously?
4. Can it be simplified without losing meaning or skipping critical instruction?
5. Is everything included valuable and worth including?
6. Does the file state anything obvious that a capable agent does not need to be
   told?

Require specific passages and concrete consequences for every `No` to questions
1–3, every `Yes` to question 4, every `No` to question 5, and every `Yes` to
question 6. If the reviewer sees no substantive problem, require it to say so.

## Judge and iterate

Evaluate every specific finding against the target's real loading context and
canonical sources. Do not count votes or apply suggestions automatically. Reject
changes that add generic reminders, broaden scope, or make the document longer
without improving execution.

Run at most two full review rounds unless the user explicitly asks for more. The
first reviews the initial draft. If accepted findings change what the target
instructs, validate the revision and run the same panel once more in fresh reviewer
conversations. Changes only to whitespace, wrapping, or Markdown layout do not
require that second round.

After the second round, apply any straightforward final corrections and stop. Ask
the user only if a substantive unresolved tradeoff remains. Do not start a third
round automatically.

If a reviewer returns without all six answers, send one corrective follow-up in
the same conversation. If an invocation fails, retry that reviewer once through
the same mechanism with the same identity. If the reviewer still produces no
valid review, stop and ask the user whether to replace or remove it.

## Definition of done

- Every named reviewer returned the six required answers for each scheduled
  review round.
- Applicable validation passes.

## Final handoff

Give the user the target file path, a concise description of the resulting
structure, the reviewer outcomes, the findings accepted or rejected, and
validation results. Do not perform the procedure's real-world actions merely to
demonstrate the file.
