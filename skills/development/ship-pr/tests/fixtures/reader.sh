#!/usr/bin/env bash
set -euo pipefail
args="$*"
mode="${GH_STUB_MODE:-ok}"
if [[ -n "${GH_FORCE_TTY:-}${CLICOLOR_FORCE:-}" ]]; then
  printf '\033[31m'
fi
if [[ "$mode" == "fail" ]]; then
  printf 'gh: boom\n' >&2
  exit 1
fi
if [[ "$mode" == "malformed" ]]; then
  printf '{'
  exit 0
fi
if [[ "$args" == *graphql* ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"isResolved":true,"isOutdated":false,"comments":{"nodes":[{"databaseId":11}]}},
  {"isResolved":false,"isOutdated":true,"comments":{"nodes":[{"databaseId":13}]}}
]}}}}}
JSON
  exit 0
fi
if [[ "$args" == *"/issues/"*"/comments"* ]]; then
  if [[ "$args" != *"--paginate"* ]]; then
    printf 'missing --paginate\n' >&2
    exit 1
  fi
  printf '%s\n' '[{"id":1,"html_url":"https://example.test/issue/1","user":{"login":"alex"},"body":"Conversation $(whoami)\n> quoted"}]'
  printf '%s\n' '[{"id":2,"html_url":"https://example.test/issue/2","user":{"login":"blair"},"body":""}]'
  exit 0
fi
if [[ "$args" == *"/pulls/"*"/comments"* ]]; then
  if [[ "$args" != *"--paginate"* ]]; then
    printf 'missing --paginate\n' >&2
    exit 1
  fi
  printf '%s\n' '[{"id":11,"html_url":"https://example.test/inline/11","user":{"login":"riley"},"path":"internal/widget.go","line":42,"side":"RIGHT","pull_request_review_id":21,"body":"Please fix this"}]'
  printf '%s\n' '[{"id":12,"html_url":"https://example.test/inline/12","user":{"login":"sam"},"in_reply_to_id":11,"path":"internal/widget.go","original_line":42,"original_side":"RIGHT","pull_request_review_id":21,"body":"Done"},{"id":13,"html_url":"https://example.test/inline/13","user":{"login":"riley"},"path":"internal/old.go","original_line":9,"original_side":"LEFT","pull_request_review_id":22,"body":"Still open"}]'
  exit 0
fi
if [[ "$args" == *"/pulls/"*"/reviews"* ]]; then
  printf '%s\n' '[{"id":21,"html_url":"https://example.test/review/21","user":{"login":"casey"},"state":"CHANGES_REQUESTED","body":"Needs work"}]'
  exit 0
fi
printf 'unexpected gh invocation: %s\n' "$args" >&2
exit 1
