# Merge Authorization

Check that the user's permission allows merging the requested PR and head
commit. Judge its limits from the supplied request's evidence and PR metadata.
Refuse if permission is missing or a limit cannot be verified.

Verify from fresh GitHub state that:

- The PR's current head matches the request's head.
- The PR is mergeable and required checks and repository gates pass.
- An agent or human reviewer has posted feedback as a review or comment.
- The supplied repository policy is satisfied, or the caller explicitly confirms
  none exists. Missing policy status is missing evidence.

Use `gh` to read all current conversation comments, review bodies, inline
comments, and replies. Confirm every request, including those in approvals,
summaries, and checklists, appears in the supplied request's feedback ledger. Each
entry must include the source link, request text, disposition, evidence, and a
link to a posted reply supporting that request. Review or thread state does not
determine eligibility. Messages without a new request need no entry or reply.

A supported reply begins `Fixed in <full commit SHA>.`, `Deferred.`, or
`Disagreed.` and identifies its fixing commit, deferral tracker, or disagreement
evidence. Accept supported deferrals and disagreements; do not re-judge any
disposition's merits. A bot's threshold, such as a coverage percentage, is not
repository policy.

Authorize only if all checks pass, naming the exact PR and head commit.
Otherwise, list all failures or missing evidence and say whether missing replies
or ledger details are the only problems.

This is a process gate. Do not merge, inspect the selected work or final diff,
or repeat the code review.
