---
name: code-review
description: >-
  Open a code diff for interactive human review in a browser, track previously
  reviewed files, and collect comments on selected code.
---

Use `python3 <skill-directory>/scripts/code_review.py start --help` to choose a
source. Add `--tailscale` for private HTTPS access from another tailnet device.

Share the returned URL and keep the session ID. End the turn while the user
reviews. When they return, run `code_review.py result SESSION` and return the
submitted comments with their file, lines, and selected text before acting.
