# Merge Authorization

Verify from current evidence that the requested head is the PR's current head,
the PR is mergeable, required checks and repository gates pass, and an agent or
human reviewer has posted feedback as a review or comment. All PR feedback must
be fully addressed. Do not inspect the selected work or final diff; this is a
process gate, not another review.

Read the PR's current comments, such as with `/ship-pr`'s
`scripts/read-pr-comments.sh`, and verify that the request includes a complete
ledger: every eligible request, including one embedded in an automated approval,
review summary, or pre-merge checklist, appears with its source link, request
text, canonical disposition with evidence, and a link to a posted reply that
supports it. Status or CI messages, factual statements, and verdicts without a
new request need no entry, and review state does not decide eligibility. A reply
supports its request when it begins with `Fixed in <full commit SHA>.`,
`Deferred.`, or `Disagreed.` and states its fixing commit, tracker, or reasoning;
do not re-judge its merits. Supported `Deferred.` and `Disagreed.` dispositions
are acceptable; a bot's threshold, such as a coverage percentage, is not
repository policy. A missing or incomplete ledger is not authorized.

If `/ship-pr`'s `references/repo-specific-pr-policy.md` exists, read it and
verify that all of its requirements are also met.

State concisely whether the exact PR and head are authorized for merge. If not
authorized, give the reason.
