---
name: playwright
description: Use globally installed `playwright-cli` for browser automation, UI inspection, screenshots, Playwright test debugging, or test generation. Trigger when a task needs browser interaction or test repair. Do not use for generic tests, web search, non-browser docs, or API-only work.
license: Apache-2.0
compatibility: Requires globally installed `playwright-cli` from the maintained `@playwright/cli` npm package and any browser, app, or Playwright test environment needed by the task. The unscoped `playwright-cli` npm package is deprecated; its replacement keeps the same binary name. Agent Layer wording describes project conventions, not an al runtime dependency.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*)
---

# Browser Automation with playwright-cli

> Modified by Conn Castle Studios on 2026-05-26 from the Apache-2.0
> playwright-cli skill: reduced duplicated command reference material and
> tailored the workflow guidance for Agent Layer.

Use globally installed `playwright-cli` from the maintained `@playwright/cli`
package as the browser control surface; installed CLI help supplies syntax.

## Defaults

- Use snapshots and element refs for navigation; use locators when refs are
  insufficient and screenshots when visual evidence matters.
- Prefer built-in commands for ordinary browser operations and simple mocks;
  use code execution only when they cannot express the behavior.

## Required artifacts

No artifact is required for ordinary inspection. Put needed scripts, state
files, traces, videos, screenshots, and saved snapshots in the temporary or
scratch directory defined by repo instructions or conventions. Saved storage
state can contain credentials; keep it temporary and uncommitted.

## Global constraints

- Before the first browser action in a session, run `playwright-cli --version`
  and `playwright-cli --help`. Run `playwright-cli --help <command>` before
  non-obvious subcommands or flags. Treat live help as authoritative for
  commands, arguments, flags, output modes, and defaults.
- If the CLI, browser, app, or test setup is missing, stop and report the
  missing prerequisite; do not install packages or browsers without an explicit
  setup request.
- Do not run `playwright-cli install --skills`.

## Human checkpoints

- Ask before installing CLI packages or browsers, changing browser
  configuration, or using a persistent profile unless the user already
  explicitly requested it.
- Ask before saving or reusing authentication state outside the repo's
  documented temporary or scratch directory.
- Ask before leaving a browser session running unless the user requested an
  interactive handoff.

## Workflow

1. Start or connect to the browser using live help.
2. Capture semantic page state, then interact using refs or locators as needed.
3. When state or refs omit needed details, choose an inspection command from
   live help. Use dashboard or visual aids when the user needs to identify or
   comment on UI.
4. Close or disconnect from the session before handoff unless an interactive
   handoff was requested. Use semantic names to keep sessions distinct.

## Help routing

Use these as `playwright-cli --help <command>` targets, not as a command manual:

- Browser/session lifecycle: `open`, `attach`, `list`, `close`, `detach`,
  `close-all`, `kill-all`.
- Page state and inspection: `snapshot`, `screenshot`, `eval`, `console`,
  `requests`, `request`.
- UI clarification: `show`, `highlight`.
- Storage and auth state: `state-save`, `state-load`, cookie and storage
  commands from root help.
- Network mocking and advanced browser logic: `route`, `run-code`.
- Debugging evidence: `tracing-start`, `tracing-stop`, `video-start`,
  `video-stop`.

## Conditional references

- Read [references/playwright-tests.md](references/playwright-tests.md) when
  running, debugging, or healing Playwright tests, especially with
  `npx playwright test --debug=cli` sessions.
- Read [references/test-generation.md](references/test-generation.md) when
  creating or updating tests from browser actions, generated code, or manually
  added assertions.

## Guardrails

- Do not use browser automation to bypass authentication, authorization, or
  site terms.
- Do not hard-code or expose secrets in commands, tests, storage state, traces,
  videos, screenshots, or logs.
- Do not add sleeps or skip Playwright hooks to make a test pass. Diagnose the
  app state and wait for specific, testable readiness instead.

## Final handoff

State which pages, flows, or tests were exercised, name created artifacts, and
report the remaining session state and verification gaps. For test work, rerun
the smallest meaningful test after the fix.
