# Skills

Skills are organized as `skills/<group>/<skill>/` so independent groups can
live alongside one another without mixing their skill directories.

When a leaf skill name exists in more than one group, install it with its
namespaced `<group>/<skill>` identifier. For example:

```bash
gh skill install nicholasjconn/skills tools/request-html-comments
```

## Development

- [`pr-retrospective`](skills/development/pr-retrospective/): Scores merged GitHub PRs and posts structured retrospective comments.

## Steward

- [`fact-check`](skills/steward/fact-check/): Produces a cited, claim-by-claim evidence report for content that needs verification.
- [`x-write`](skills/steward/x-write/): Turns Nick's rough dictation or source material into a draft X post or reply.

## Tools

- [`request-html-comments`](skills/tools/request-html-comments/): Collects element- and text-linked feedback on local HTML through an interactive browser overlay.
