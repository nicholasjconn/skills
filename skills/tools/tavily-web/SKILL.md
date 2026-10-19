---
name: tavily-web
description: |
  Use Tavily CLI for web search, URL extraction, site mapping, and cited research. Trigger when the user needs current web info, asks to search/read a page, provides URLs, or wants a sourced report. Do not use for browser automation, local docs, or Tavily setup.
compatibility: Requires the Tavily CLI (`tvly`), authentication, and network access. Agent Layer retrieval/scratch wording describes project conventions, not an al runtime dependency.
allowed-tools: Bash(tvly:*)
---

# Tavily Web

Use the Tavily CLI for the smallest retrieval needed, then return a sourced
answer that distinguishes retrieved facts from your synthesis.

## Defaults

- Run read-only `tvly search`, `extract`, `map`, or `research` without asking
  for additional permission. Installation, login/authentication commands, and
  configuration changes require an explicit user setup request.
- Prefer `--json` when supported. Keep searches short and focused; use relevant
  domain/time filters or selected URLs instead of dumping large raw outputs.
- Quick lookups need no artifact. Save needed retrieval output in `.agent-layer/tmp/`
  as `tavily-web.<run-id>.<type>` with a `.json` or `.md` extension.
- Do not use Tavily MCP or Fetch MCP as a fallback, or `tvly crawl` in the
  default Agent Layer workflow.

## Live CLI help and readiness

Start a Tavily session with `tvly --help`, then `tvly --status`.
Installed help is authoritative for commands, flags, output modes, and defaults.
Check relevant command help before non-obvious flags:
`tvly search --help`, `tvly extract --help`, `tvly map --help`, or
`tvly research <subcommand> --help`.

If the CLI is missing or a readiness/command check fails, report the command,
exit status when available, and actual diagnostic. Recommend installation or
login only when the evidence identifies that prerequisite; nonzero status alone
can also reflect arguments, network/service errors, inaccessible pages, or
other failures. Correct a supported invocation error using live help; report
remaining blockers without substituting tools or performing setup.

## Command routing

| Command | Use when |
| --- | --- |
| `tvly search` | Discover sources, current facts, news, or relevant pages when no exact URL is supplied. Keep source discovery separate from requested synthesis. |
| `tvly extract` | Read supplied exact URLs directly, or selected search/map results that need page content or query-focused chunks. Skip search for a known URL. |
| `tvly map` | Discover URLs or structure within a known site/domain, then extract only useful pages. Use search for general web discovery. |
| `tvly research` | The user wants multi-source cited synthesis, comparison, or a report. Use search/extract for quick facts or discovery alone. |

For research that would block, use `--no-wait` to obtain and retain the request
ID, then use the live-help status/poll flow.

## Final handoff

Summarize the result and cite the source URLs supporting it. Distinguish sourced
facts from your synthesis rather than treating Tavily output as authoritative.
Name the command path and any saved artifacts. Report actual access failures,
errors/timeouts, and incomplete coverage, identifying affected pages or claims
and what remains unverified or is needed to proceed.
