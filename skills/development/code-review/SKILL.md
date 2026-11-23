---
name: code-review
description: >-
  Open a code diff for interactive human review in a browser, track previously
  reviewed files, and collect comments on selected code.
---

Use `python3 <skill-directory>/scripts/code_review.py start --help` to choose a
source. Add `--tailscale` for private HTTPS access from another tailnet device.
Image previews are limited to 32 MiB per image and 128 MiB per review.

Share the returned URL and keep the session ID. End the turn while the user
reviews. When they return, run `code_review.py result SESSION` and check the
status. If it is `submitted`, return the comments with their file, lines, and
selected text before applying actionable feedback and verifying the changes.
Pause when the reviewer requests discussion or a decision is needed.

For any other status, report it and pause. If the status is `pending`, ask the
user to submit the review. Missing comments do not imply approval.
