# Skills

Skills are organized as `skills/<group>/<skill>/` so independent groups can
live alongside one another without mixing their skill directories.

When a leaf skill name exists in more than one group, install it with its
namespaced `<group>/<skill>` identifier. For example:

```bash
gh skill install nicholasjconn/skills steward/request-html-comments
```

The current Steward skills are:

- [`fact-check`](skills/steward/fact-check/)
- [`request-html-comments`](skills/steward/request-html-comments/)
- [`x-write`](skills/steward/x-write/)

The expected source for `request-html-comments` is
[`skills/steward/request-html-comments`](https://github.com/nicholasjconn/skills/tree/main/skills/steward/request-html-comments).
