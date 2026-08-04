---
name: fact-check
description: >-
  Verify factual or current claims in drafts, posts, reports, decisions, or
  agent-prepared text by producing a cited claim ledger, independent source
  trace, contradiction pass, and publication-risk report. Use when evidence is
  needed before publication, approval, or downstream reliance. Do not use for
  copyediting, persuasion, open-ended research synthesis, or quick answers that
  do not need a durable evidence report.
---

# fact-check

Fact-check exact claims and write a durable evidence report. The report is the
deliverable: every checked claim needs a status, evidence tier, inspected
sources, source provenance, contradiction pass, and recommended handling.

## Defaults

- Check only claims supplied by the user or directly implied by supplied
  claim-bearing material.
- Split compound statements into atomic claims before checking.
- Inspect supplied exact sources before searching for alternatives.
- Use current retrieval for anything that can change over time.
- Preserve claim meaning; do not broaden, soften, or replace the claim to make
  it easier to verify.
- Do not draft, rewrite, polish, publish, send, or queue external-facing text.

## Inputs

Accept:
- exact claims
- draft text, posts, replies, reports, decks, or notes containing claims
- intended use or publication context
- supplied URLs, local paths, screenshots, snippets, datasets, or constraints
- required source list or source exclusions
- requested report path

If no checkable claim or claim-bearing material is supplied, stop and ask for
the exact claims or material to check.

## Required Artifact

Write one Markdown report to the user-specified path. If no path is supplied,
write:

```text
.agent-layer/tmp/fact-check.<run-id>.report.md
```

Create the parent directory if needed and create the report before evidence
gathering so partial progress is recoverable.

## Global Constraints

1. **Exact claim only.** Verify the claim as written. If evidence supports a
   narrower or different claim, do not mark the original `verified`.
2. **Exact source first.** For supplied URLs, files, screenshots, or datasets,
   inspect that exact item first. For public URLs, follow any web-access rules
   in the active environment and exhaust its authorized retrieval methods before
   declaring the source inaccessible. Prior knowledge, related pages, snippets,
   excerpts, secondary writeups, and search results are not substitutes.
3. **Scoped access blockers.** If an exact requested or primary source for a
   claim is inaccessible after the full chain, mark affected claims `blocked`,
   do not substitute sources for those claims, and stop dependent verification.
   Stop the whole run and ask the user only when that source is central to the
   request, the request is to read or summarize that exact source, or all
   claims are blocked.
4. **No snippet citations.** Never cite search snippets, AI summaries, ads,
   previews, social reposts without provenance, or source titles as evidence.
5. **Current means current.** For mutable facts, record retrieval date and use
   sources current enough for the claim. Use absolute dates in the report, not
   `today`, `yesterday`, or `recently`.
6. **Independence is mandatory for non-trivial external claims.** If the claim
   will be relied on externally and is not trivial, it must have independent
   verification at the required tier or be `partially_verified`, `unsupported`,
   or `blocked`.
7. **Contradictions are findings.** Run a concrete disconfirming route for
   every non-opinion claim and surface conflicts; do not bury them in prose or
   average them into confidence language.

### Evidence Tiers

Assign one tier per claim:

- `low`: trivial, non-controversial, low-impact if wrong, and not relied on by
  an external reader for a decision. Minimum: one authoritative primary or
  source-owner source.
- `medium`: non-trivial, external-facing, current, reputational, comparative,
  market, trend, adoption, or decision-relevant. Minimum: a primary/source-owner
  route, one independent-primary route, and a concrete contradiction pass.
- `high`: medical, legal, financial, regulatory, employment, safety,
  confidential, named-person, reputationally sensitive, or otherwise
  high-impact. Minimum: current primary/source-owner evidence, at least two
  independent routes with distinct provenance, including one independent-primary
  route when an observable primary route exists, and explicit residual risk.

A claim is trivial only if wrongness would not mislead a reader, embarrass the
user, or affect a decision. When unsure, treat it as non-trivial. Evidence
below the assigned tier cannot produce `verified`.

### Independence Standard

Two sources are independent only if they do not trace to the same origin: not
the same press release, wire story, dataset, author, filing, claimant
communication, or vendor-commissioned material. Identify provenance before
counting a source as independent. Republishes, rewrites, and restatements do
not count.

Independence may be waived only for a claim purely about a source's own
statement, policy, code, or document contents, and only when the claim is not an
observable real-world fact. Authority over one's own statements is not
authority over external facts such as uptime, revenue, headcount, adoption,
performance, safety, reputation, or market position.

### Source Tiers

Record both `Role` and `Tier` for every source:

- `Role`: `supplied` or `discovered`.
- `Tier`: `source-owner`, `primary`, `independent-primary`,
  `independent-secondary`, or `secondary`.

`independent-primary` means a non-claimant source with direct observation,
original data, official records, or a disclosed methodology. Secondary sources
can add context but do not satisfy a medium-tier independence requirement by
themselves.
`independent-secondary` means distinct origin but no direct observation,
original data, official record, or disclosed methodology; it can corroborate
context but does not satisfy medium/high independent-primary requirements.

### Conflict Handling

When credible sources conflict, rank them by primacy, recency for mutable
facts, and methodology quality. If the conflict survives that ranking, mark the
claim `disputed`, cite both sides, and surface it in the summary.

## Human Checkpoints

Stop and ask the user only when one of these occurs:
- no checkable claim-bearing input exists
- an inaccessible exact source is central to the request, the request is to
  read or summarize that source, or all claims are blocked
- the user asks for a broader investigation than the supplied claims imply
- verification would require paid access, login, private data, browser-cookie
  use, external communication, or another side effect not already authorized
- the only defensible recommendation is a substantive rewrite whose tradeoff is
  not obvious from the evidence

## Source Routing

- Local repo or file claims: use local files, `rg`, package metadata, schemas,
  tests, generated artifacts, and command help before web search.
- Supplied public URLs: apply **Exact source first** and record which access
  method returned the full primary text.
- Unsourced claims: map the claim to the canonical owner class before using
  convenient secondary coverage. Use regulators or official journals for law;
  filings, investor relations, or company source material for corporate
  metrics; primary papers or trial registries for science; official statistics
  agencies or source datasets for public data. If no owner can be identified,
  mark `unsupported` with that reason.
- GitHub claims: use the local checkout first when present; otherwise use `gh`
  for repository contents, releases, issues, pull requests, Actions, and API
  metadata.
- X/Twitter claims: use an available source-native tool or API for specific
  posts or accounts before generic web search.
- Software/API claims: use repo-local docs, installed CLI help, package
  metadata, release notes, and official docs before secondary tutorials.
- Statistics/data claims: record denominator, period, geography, units,
  methodology, publication/retrieval date, base rate, absolute-vs-relative
  framing, and baseline/window selection. A correct number with misleading
  framing is `partially_verified` with a framing note.
- News, market, reputation, adoption, trend, and competitor claims: explore
  independent reporting, filings, datasets, usage artifacts, reviews,
  community discussion, or other observable traces outside the claimant's own
  materials.
- Quotes: verify exact wording, speaker/attribution, and surrounding context
  against the original recording, transcript, post, document, or archive. If
  only secondary quotation remains after the access chain, mark at most
  `partially_verified` and label it secondary.
- Screenshots/media: inspect the supplied image as an artifact, then trace the
  claim to the live primary source it purports to show. Do not treat an image
  as self-authenticating. If the live source is unreachable, mark the
  image-derived claim `unsupported` or `blocked`; flag visible staleness,
  cropping, inconsistent UI, or manipulation signs.

When command syntax is unclear, run `--help` or inspect local docs before using
the command.

## Statuses

- `verified`: evidence meeting the claim's assigned tier supports the claim as
  written, including independent confirmation where required.
- `partially_verified`: evidence supports a narrower, qualified, adjacent, or
  context-dependent version, but not the claim exactly as written.
- `unsupported`: evidence found does not substantiate the claim, no
  determinable referent exists, or evidence is below the required tier. Record
  which reason applies.
- `contradicted`: inspected evidence conflicts with the claim.
- `disputed`: credible sources conflict after primacy, recency, and methodology
  ranking.
- `opinion_or_framing`: the statement is not externally fact-checkable except
  as attribution, wording, or cited evidence.
- `blocked`: verification cannot continue without a required source, access,
  user decision, or authorized side effect.

Vague quantifiers and superlatives such as "leading," "best-in-class," or
"many experts say" are `unsupported` when they have no determinable referent;
recommend `narrow` or `remove`, not `opinion_or_framing`.

## Workflow

1. **Initialize the report.** Record retrieval date, user request, intended
   use, report path, and scope boundaries.
2. **Extract claims.** Build a numbered claim ledger. Preserve original wording
   and add an atomic normalized claim for each factual assertion.
3. **Plan evidence.** For each claim, assign risk tier, source owner, freshness
   need, minimum evidence standard, exact-source route, independent route when
   required, and contradiction route.
4. **Retrieve evidence.** Inspect exact supplied sources first, then primary
   and independent sources. Record source role, tier, provenance, access
   method, retrieval date, and source location.
5. **Run contradiction and conflict passes.** Execute the planned
   disconfirming route for every non-opinion claim. Check stale data, changed
   policies, entity confusion, quote drift, quote context, media authenticity,
   unit or denominator errors, causality overreach, misleading statistics
   framing, and credible contrary evidence. "None found" is valid only when
   paired with the route actually run.
6. **Classify and recommend.** Assign one status per claim and recommend
   `keep`, `narrow`, `attribute`, `remove`, or `block until resolved`.
7. **Set aggregate verdict.** Overall risk is the maximum claim risk. Any
   unresolved `contradicted`, `disputed`, or high-risk `blocked`/`unsupported`
   claim requires user review before external use. `partially_verified` claims
   may be used only with the recommended narrowing or attribution applied.
8. **Write and self-check the report.** Keep it compact but complete enough for
   a reviewer to trace decisions without rerunning the search.

## Report Format

```md
# Fact Check

## Summary
- Retrieval date:
- Scope:
- Status breakdown:
- Overall risk tier:
- Aggregate verdict:
- Recommended handling:
- Blockers:

## Claim Ledger
1. ID:
   Original claim:
   Normalized claim:
   Risk tier:
   Status:
   Status reason:
   Evidence standard:
   Evidence:
   Source-owner/primary route:
   Independent verification:
   Contradiction pass:
   Conflicts:
   Recommended handling:
   Residual risk:

## Source Notes
- Source:
  Role:
  Tier:
  Provenance/origin:
  Access method:
  Retrieval date:
  Location:
  Full primary content inspected:
  Notes:

## Blockers and Limits
- ...
```

For `Independent verification`, cite source(s) meeting the claim's assigned
Evidence Tier (`independent-primary` for medium; the required independent routes
for high) whose provenance qualifies under the Independence Standard, or state
the bounded waiver reason. Use short paraphrases. Quote only when exact wording
matters and keep quotes brief.

## Pre-Handoff Self-Check

Before returning, verify:
- every supplied or extracted factual claim has a risk tier, status, and status
  reason
- every non-opinion claim lists inspected evidence or an explicit blocker
- exact supplied sources were inspected directly or affected claims are blocked
  under the scoped access rule
- every medium/high claim has qualifying independent verification or a bounded
  waiver reason
- every non-opinion claim's contradiction pass names the route actually run;
  "none found" without a route fails
- every cited source has role, tier, provenance, access method, retrieval date,
  and location
- no cited evidence comes from snippets, AI summaries, titles, or previews
- unsupported, contradicted, disputed, partially verified, and blocked claims
  are visible in the summary and aggregate verdict

If any check fails and the data supports fixing it, fix the report once before
handoff. If the data cannot support it, mark the gap explicitly.

## Guardrails

- Do not turn a fact-check into broad research unless the user explicitly asks.
- Do not mark source-owner evidence as independent.
- Do not make claims stronger than the inspected evidence supports.
- Do not treat absence of evidence as contradiction unless the source should
  contain the fact and its absence is meaningful.
- Do not hide uncertainty behind confidence language.
- Do not cite a source unless the relevant content was actually retrieved and
  inspected.
- Do not silently replace an inaccessible exact source with another source.
- Do not treat screenshots or media as self-authenticating.

## Definition of Done

- The Markdown report exists at the agreed path.
- The report contains a claim ledger with one status and risk tier per claim.
- Source notes record role, tier, provenance, access method, retrieval date, and
  location for every cited source.
- Each non-opinion claim has evidence or a blocker, plus a contradiction route
  and result.
- The summary includes status breakdown, overall risk, aggregate verdict, and
  all non-clean claims.

## Final Handoff

Return only:
- report path
- status breakdown
- overall risk tier and aggregate verdict
- recommended handling
- claims that remain `partially_verified`, `unsupported`, `contradicted`,
  `disputed`, or `blocked`
