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
count_file="${GH_STUB_COUNT_FILE:-}"
snapshot=0
if [[ -n "$count_file" && -f "$count_file" ]]; then
  snapshot="$(cat "$count_file")"
fi
if [[ "$args" == *"pr view"* ]]; then
  snapshot=$((snapshot + 1))
  if [[ -n "$count_file" ]]; then
    printf '%s\n' "$snapshot" >"$count_file"
  fi
  if [[ "$snapshot" -ge 2 && -n "${GH_STUB_PR_STATE_2:-}" ]]; then
    cat "${GH_STUB_PR_STATE_2}"
  else
    cat "${GH_STUB_PR_STATE_1}"
  fi
  exit 0
fi
if [[ "$args" == *"/pulls/"*"/comments"* ]]; then
  if [[ "$args" != *"--paginate"* ]]; then
    printf 'missing --paginate\n' >&2
    exit 1
  fi
  if [[ "$snapshot" -ge 2 && -n "${GH_STUB_COMMENTS_2:-}" ]]; then
    cat "${GH_STUB_COMMENTS_2}"
  else
    cat "${GH_STUB_COMMENTS_1}"
  fi
  exit 0
fi
printf 'unexpected gh invocation: %s\n' "$args" >&2
exit 1
