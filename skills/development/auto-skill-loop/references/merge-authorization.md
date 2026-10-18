# Merge Authorization

Use the supplied permission and fresh GitHub state to verify:

- The user's permission allows merging this PR and commit within its limits.
- The current head matches, the PR is mergeable, required checks and repository
  gates pass, and any supplied repository policy is satisfied.
- An agent or human reviewer has posted feedback.
- Every request in comments and reviews, including approvals, summaries, and
  checklists, appears in the handoff with its source link, request text,
  disposition, evidence, and posted reply link.

Each reply must begin `Fixed in <full commit SHA>.`, `Deferred.`, or `Disagreed.`
and identify its fixing commit, deferral tracker, or disagreement evidence.
Accept supported deferrals and disagreements without re-judging their merits.
Messages without a request need no reply.

Authorize only if all checks pass, naming the exact PR and commit. Otherwise,
list all failures or missing evidence and say whether missing replies or handoff
details are the only problems. Do not merge or repeat the code review.
