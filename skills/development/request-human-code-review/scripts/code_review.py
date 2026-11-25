#!/usr/bin/env python3
"""Open a code diff snapshot for interactive browser review."""

import argparse
import fcntl
import gzip
import hashlib
import json
import multiprocessing
import os
import re
import secrets
import select
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from functools import cache, cached_property
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import accumulate, count, groupby, islice
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
from media import ImageBudget, describe, image_type, load_blobs, patch_blobs
from patch_input import DIFF_HEADER, HUNK, file_paths, patch_sections
from tailnet import Tailnet

ASSETS = Path(__file__).resolve().parent
LIFETIME = 12 * 3600
# The page holds every diff, so a file's diff and the whole review are both limited.
# Lines are limited as well as bytes because each line costs memory and page size however short it is.
MAX_FILE_DIFF = 500 * 1024
MAX_REVIEW_FILES = 300
MAX_REVIEW_DIFF = 3 * 1024 * 1024
MAX_REVIEW_LINES = 100_000
# Highlighting a file costs about as much as 4,000 characters of its text before the first line.
# A worker process is worth starting for each 200,000 characters of such work.
HIGHLIGHT_FILE_COST = 4_000
HIGHLIGHT_WORKER_LOAD = 200_000
GIT_DIFF = (
    "--patch", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv",
    "--no-relative", "--submodule=short", "--ignore-submodules=dirty", "-U3",
    "--src-prefix=a/", "--dst-prefix=b/", "--word-diff=none",
    "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
)
BINARY_NOTE = re.compile(rb"^(GIT binary patch|Binary files .* differ)\r?$", re.MULTILINE)
LINE_TOKENS = re.compile(r"\w+|\s+|[^\w\s]")
MAX_INLINE_LINE = 4096
# Bound the cost of matching repeated tokens per comparison and per file.
MAX_INLINE_TOKENS = 400
MAX_INLINE_TOKEN_WORK = 4_000_000
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"


@cache
def git_local_variables():
    local = set(subprocess.check_output(["git", "rev-parse", "--local-env-vars"], text=True).split())
    local.update(("GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"))
    return local


def git_command(repo, *args):
    local = git_local_variables()
    environment = {name: value for name, value in os.environ.items() if name not in local}
    environment["LC_ALL"] = "C"
    return ["git", "--no-optional-locks", "-c", "diff.suppressBlankEmpty=false", "-C", repo, *args], environment


def git(repo, *args, allowed=(0,), input_bytes=None):
    command, environment = git_command(repo, *args)
    process = subprocess.run(
        command, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, env=environment,
    )
    if process.returncode not in allowed:
        error = process.stderr.decode(errors="replace").strip()
        raise ValueError(f"git {args[0]} failed in {repo}: {error or process.returncode}")
    return process.stdout


@contextmanager
def object_reader(repo):
    """Yield read(object ID), answered by one Git process for the whole review."""
    command, environment = git_command(repo, "cat-file", "--batch")
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=environment) as process:
        def read(object_id):
            process.stdin.write(object_id + b"\n")
            process.stdin.flush()
            size = process.stdout.readline().rpartition(b" ")[2].strip()
            content = process.stdout.read(int(size) + 1)[:-1] if size.isdigit() else None
            if content is None or len(content) != int(size):
                raise ValueError(f"git cat-file could not read {object_id.decode()} in {repo}")
            return content

        try:
            yield read
        finally:
            process.stdin.close()


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def display(data):
    return data.decode("utf-8", errors="replace")


def markup_lines(path, source):
    """Return one highlighted HTML string per line, or None when no lexer handles the file."""
    from pygments import highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_for_filename
    from pygments.util import ClassNotFound

    # Git splits lines on LF. Keep embedded carriage returns on their original line.
    source = source.replace("\r", " ")
    try:
        lexer = get_lexer_for_filename(path, source, stripnl=False, ensurenl=False)
    except ClassNotFound:
        return None
    lines = highlight(source, lexer, HtmlFormatter(nowrap=True)).split("\n")
    # The formatter ends its last line even when the source does not.
    if len(lines) == source.count("\n") + 2 and not lines[-1]:
        lines.pop()
    return lines


def end_with_server():
    """End a highlighting worker when its server dies, where it would otherwise wait for work forever."""
    def watch():
        multiprocessing.parent_process().join()
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def mark_inline_changes(rows):
    """Mark token changes in the same replacement lines shown together in split view."""
    remaining_work = MAX_INLINE_TOKEN_WORK
    for changed, block in groupby(rows, key=lambda row: row["kind"] in ("add", "remove")):
        if not changed:
            continue
        removed, added = [], []
        for row in block:
            (removed if row["kind"] == "remove" else added).append(row)
        for old, new in zip(removed, added):
            before, after = old["text"], new["text"]
            if not before or not after or before == after or max(len(before), len(after)) > MAX_INLINE_LINE:
                continue
            left, right = LINE_TOKENS.findall(before), LINE_TOKENS.findall(after)
            work = len(left) * len(right)
            if max(len(left), len(right)) > MAX_INLINE_TOKENS or work > remaining_work:
                continue
            match = SequenceMatcher(None, left, right, autojunk=False)
            if match.quick_ratio() < .5:
                continue
            remaining_work -= work
            # Repeated runs can make the longest contiguous match align a line
            # with a shifted copy. Keep a single replacement in place, and let
            # the matcher preserve shifts when other alignments tie.
            aligned = 0.0
            single_replacement = False
            if len(left) == len(right):
                matching_tokens = sum(a == b for a, b in zip(left, right))
                aligned = matching_tokens / len(left)
                single_replacement = matching_tokens == len(left) - 1
            similarity = aligned if single_replacement else match.ratio()
            if max(aligned, similarity) < .5:
                continue
            if single_replacement or aligned > similarity:
                spans = []
                for equal, positions in groupby(range(len(left)), key=lambda i: left[i] == right[i]):
                    if not equal:
                        run = list(positions)
                        spans.append((run[0], run[-1] + 1))
                left_spans = right_spans = spans
            else:
                edits = [edit for edit in match.get_opcodes() if edit[0] != "equal"]
                left_spans = [(a, b) for _, a, b, _, _ in edits if a < b]
                right_spans = [(c, d) for _, _, _, c, d in edits if c < d]
            for row, tokens, spans in ((old, left, left_spans), (new, right, right_spans)):
                if spans:
                    # DOM text offsets count UTF-16 units, including surrogate pairs.
                    offsets = list(accumulate((len(token.encode("utf-16-le")) // 2 for token in tokens), initial=0))
                    row["inline_changes"] = [(offsets[start], offsets[end]) for start, end in spans]


@dataclass
class FileDiff:
    old_path: str | None
    new_path: str | None
    change: str
    patches: tuple[bytes, ...]
    baseline_blob: bytes = b""
    head_blob: bytes = b""
    old_mode: bytes = b""
    new_mode: bytes = b""
    blobs: dict = field(default_factory=dict)
    sources: dict = field(default_factory=dict)
    rendered: list = field(default_factory=list)
    hidden: bytes | None = None

    @property
    def path(self):
        return self.new_path or self.old_path

    @cached_property
    def key(self):
        return json.dumps([self.old_path, self.new_path])

    @cached_property
    def version(self):
        return hashlib.sha256(b"\0".join((self.baseline_blob, *self.patches))).hexdigest()

    @cached_property
    def binary(self):
        return any(BINARY_NOTE.search(patch) for patch in self.patches)

    def metadata(self):
        return {
            "path": self.path, "old_path": self.old_path, "new_path": self.new_path,
            "change": self.change, "version": self.version,
        }

    @cached_property
    def diff_size(self):
        """Bytes of diff text. A binary change is summarized or previewed, never shown as text."""
        return 0 if self.binary else sum(len(patch) for patch in self.patches)

    @property
    def too_large(self):
        return self.diff_size > MAX_FILE_DIFF

    @cached_property
    def line_counts(self):
        if self.too_large:
            # Count without building a row for every line.
            hunks = [patch[patch.find(b"\n@@"):] for patch in self.patches]
            return {"additions": sum(part.count(b"\n+") for part in hunks),
                    "deletions": sum(part.count(b"\n-") for part in hunks)}
        return {
            "additions": sum(row["kind"] == "add" for row in self.rows),
            "deletions": sum(row["kind"] == "remove" for row in self.rows),
        }

    @cached_property
    def rows(self):
        if self.too_large:
            return [{"kind": "note", "text": f"Diff not shown: {self.diff_size / 2**20:.1f} MiB is over the "
                                             f"{MAX_FILE_DIFF // 1024} KiB limit for one file."}]
        rows = []
        for patch in self.patches:
            old_left = new_left = 0
            patch_start = len(rows)
            for line in patch.split(b"\n"):
                if line.startswith(b"diff --git "):
                    continue
                if BINARY_NOTE.fullmatch(line):
                    break
                match = HUNK.match(line)
                if match:
                    old, new = int(match[1]), int(match[3])
                    old_left, new_left = int(match[2] or 1), int(match[4] or 1)
                    rows.append({"kind": "hunk", "text": display(line.removesuffix(b"\r")),
                                 "old_range": display(match[0].split(b" ")[1]),
                                 "new_range": display(match[0].split(b" ")[2])})
                elif (old_left or new_left) and line[:1] in (b"+", b"-", b" "):
                    indicator = line[:1]
                    rows.append({
                        "kind": {b"+": "add", b"-": "remove", b" ": "context"}[indicator],
                        "old_line": old if indicator != b"+" else None,
                        "new_line": new if indicator != b"-" else None,
                        "text": display(line[1:].removesuffix(b"\r")),
                    })
                    old += indicator != b"+"
                    new += indicator != b"-"
                    old_left -= indicator != b"+"
                    new_left -= indicator != b"-"
                elif len(rows) > patch_start and line.startswith(b"\\ No newline at end of file") and "old_line" in rows[-1]:
                    rows[-1]["no_newline"] = True
                elif line and not line.startswith((b"index ", b"--- ", b"+++ ", b"similarity index ")):
                    rows.append({"kind": "note", "text": display(line)})
        if not rows and not self.binary:
            rows.append({"kind": "note", "text": "No textual changes"})
        return rows

    @cached_property
    def has_code(self):
        return any("old_line" in row for row in self.rows)

    @cached_property
    def texts(self):
        """Each side's whole text, where Git supplied it."""
        return {side: display(content).replace("\r\n", "\n") for side, content in self.sources.items()}

    def hunk_sources(self, rows, side):
        """Yield (rows, text) for one side of each hunk, to highlight when the whole file is not available."""
        line_key = f"{side}_line"
        for hunk in split_hunks(rows):
            code_rows = [row for row in hunk if row.get(line_key) is not None]
            if code_rows:
                yield code_rows, "\n".join(row["text"] for row in code_rows) + "\n"

    @property
    def highlight_cost(self):
        """About how many characters this file gives the highlighter, counting what each side costs to begin."""
        sides = (self.old_path is not None) + (self.new_path is not None)
        return sides * HIGHLIGHT_FILE_COST + (sum(map(len, self.sources.values())) or self.diff_size)

    def render(self):
        """Build the rows of the file's diff, with the lines hidden between hunks carried inside each gap."""
        markup = cache(markup_lines)
        rows = [dict(row) for row in self.rows]
        mark_inline_changes(rows)
        for side, path in (("old", self.old_path), ("new", self.new_path)):
            if path is None:
                continue
            line_key = f"{side}_line"
            html_key = f"{side}_html"
            text = self.texts.get(side)
            if text is not None:
                source_lines = text.split("\n")
                highlighted = markup(path, text)
                if highlighted is None:
                    continue
                if len(highlighted) == len(source_lines):
                    for row in rows:
                        line = row.get(line_key)
                        if line is not None and 0 < line <= len(highlighted) and source_lines[line - 1] == row["text"]:
                            row[html_key] = highlighted[line - 1]
                    continue
            # Patches may contain only the hunks. Keep the two lexer states separate.
            for code_rows, source in self.hunk_sources(rows, side):
                highlighted = markup(path, source)
                if highlighted is None:
                    break
                if len(highlighted) == len(code_rows) + 1:
                    for row, html in zip(code_rows, highlighted):
                        row[html_key] = html

        baseline = self.sources.get("old")
        gaps = self.context_gaps(baseline) if baseline else {}
        if gaps:
            # Unchanged lines come from the immutable Git baseline, even in a worktree review.
            lines = self.texts["old"].split("\n")
            highlighted = markup(self.old_path, self.texts["old"])
            if highlighted is not None and len(highlighted) != len(lines):
                highlighted = None
        # Reserve row indices for hidden lines so expanding a gap cannot move a comment anchor.
        visible = []
        index = 0
        for position in range(len(rows) + 1):
            if gap := gaps.get(position):
                first, last = gap["old"] - 1, gap["old"] - 1 + gap["count"]
                gap = {**gap, "kind": "gap", "index": index, "text": [line.removesuffix("\r") for line in lines[first:last]]}
                if highlighted is not None:
                    gap["html"] = highlighted[first:last]
                if last == len(lines) and not baseline.endswith(b"\n"):
                    gap["no_newline"] = True
                visible.append(gap)
                index += gap["count"]
            if position < len(rows):
                rows[position]["index"] = index
                visible.append(rows[position])
                index += 1
        return visible

    def context_gaps(self, baseline):
        if not self.new_path or self.binary or len(self.patches) != 1:
            return {}
        gaps = {}
        old_end = new_end = 0
        total = baseline.count(b"\n") + (not baseline.endswith(b"\n"))
        for position, row in enumerate(self.rows):
            if row["kind"] != "hunk":
                continue
            match = HUNK.match(row["text"].encode())
            old_count, new_count = int(match[2] or 1), int(match[4] or 1)
            old_before = int(match[1]) - (old_count != 0)
            new_before = int(match[3]) - (new_count != 0)
            count = old_before - old_end
            if count < 0 or count != new_before - new_end or old_before + old_count > total:
                return {}
            if count:
                gaps[position] = {"old": old_end + 1, "new": new_end + 1, "count": count,
                                  "up": True, "down": old_end > 0 or new_end > 0}
            old_end, new_end = old_before + old_count, new_before + new_count
        if old_end < total:
            gaps[len(self.rows)] = {"old": old_end + 1, "new": new_end + 1, "count": total - old_end,
                                    "up": False, "down": True}
        return gaps

    def selected_rows(self, start, stop):
        gaps = count()
        hidden = None
        for row in self.rendered:
            index = row["index"]
            if index >= stop:
                break
            if row["kind"] == "gap":
                position = next(gaps)
                if start < index + row["count"]:
                    # A comment on lines the reviewer expanded quotes them from the file's hidden lines.
                    hidden = hidden or json.loads(gzip.decompress(self.hidden))
                    for line in range(max(start, index), min(stop, index + row["count"])):
                        offset = line - index
                        yield {"kind": "context", "index": line, "old_line": row["old"] + offset,
                               "new_line": row["new"] + offset, "text": hidden[position]["text"][offset]}
            elif start <= index:
                yield row


def split_hunks(rows):
    hunk = []
    for row in rows:
        if row["kind"] == "hunk":
            if hunk:
                yield hunk
            hunk = []
        elif "old_line" in row:
            hunk.append(row)
    if hunk:
        yield hunk


def check_size(files):
    """Refuse a comparison too large for one page, with the numbers the caller needs to narrow it."""
    shown = [file for file in files if not file.too_large]
    size = sum(file.diff_size for file in shown)
    lines = sum(patch.count(b"\n") for file in shown if not file.binary for patch in file.patches)
    if len(files) > MAX_REVIEW_FILES or size > MAX_REVIEW_DIFF or lines > MAX_REVIEW_LINES:
        raise ValueError(
            f"This comparison is too large to review at once: {len(files)} changed files (limit {MAX_REVIEW_FILES}), "
            f"{size / 2**20:.1f} MiB of diff (limit {MAX_REVIEW_DIFF // 2**20} MiB) "
            f"and {lines:,} diff lines (limit {MAX_REVIEW_LINES:,}). "
            "Review a smaller range with --base and --head, or part of it with --patch.")


def tracked_diffs(output):
    if not output:
        return []
    raw, delimiter, patch = output.partition(b"\0\0")
    if not delimiter:
        raise ValueError("Git returned an invalid raw diff header")
    fields = iter(raw.split(b"\0"))
    offsets = [match.start() for match in DIFF_HEADER.finditer(patch)] + [len(patch)]
    patches = iter(patch[start:end] for start, end in zip(offsets, offsets[1:]))
    files = []
    try:
        for header in fields:
            old_mode, new_mode, old_id, new_id, status = header.split()
            kind = chr(status[0])
            path = os.fsdecode(next(fields))
            other = os.fsdecode(next(fields)) if kind in "RC" else path
            count = 2 if kind == "T" else 1
            parts = tuple(islice(patches, count))
            if len(parts) != count:
                raise ValueError("Missing patch record")
            files.append(FileDiff(
                None if kind == "A" else path, None if kind == "D" else other,
                kind, parts, b"" if kind == "A" else old_id, new_id,
                old_mode.removeprefix(b":"), new_mode,
            ))
    except (StopIteration, ValueError) as error:
        raise ValueError("Git returned mismatched file and patch records") from error
    if next(patches, None) is not None:
        raise ValueError("Git returned extra patch records")
    return files


def git_snapshot(args):
    repo = Path(os.fsdecode(git(args.repo, "rev-parse", "--show-toplevel").removesuffix(b"\n")))
    branch = display(git(repo, "symbolic-ref", "--quiet", "HEAD", allowed=(0, 1))).strip()
    current = display(git(repo, "rev-parse", "--verify", "--quiet", "HEAD", allowed=(0, 1))).strip()

    def commit(ref):
        return display(git(repo, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")).strip()

    if args.base == "HEAD" and not current and branch and not args.head:
        base = display(git(repo, "hash-object", "-t", "tree", "--stdin", input_bytes=b"")).strip()
    else:
        base = commit(args.base)
    head = commit(args.head) if args.head else None
    if args.merge_base:
        base = display(git(repo, "merge-base", base, head)).strip()
    revisions = [base, head] if head else [base]
    tracked = git(repo, "diff", "--raw", "-z", "--abbrev=64", "--find-renames", *GIT_DIFF, *revisions, "--")
    files = tracked_diffs(tracked)
    if not head:
        untracked = [os.fsdecode(path) for path in
                     git(repo, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0") if path]
        for path in untracked:
            if path.endswith("/"):
                raise ValueError(f"Untracked nested repository {path!r}. Add or ignore it before reviewing.")

        def added(path):
            patch = git(repo, "diff", "--no-index", *GIT_DIFF, "--", os.devnull, path, allowed=(0, 1))
            if not patch.startswith(b"diff --git "):
                raise ValueError(f"Git returned no patch for untracked file {path!r}")
            return FileDiff(None, path, "?", (patch,))

        # Git has no batch form of this diff, so each untracked file costs one process.
        with ThreadPoolExecutor() as pool:
            files.extend(pool.map(added, untracked))
    scope = json.dumps([
        str(repo), args.base, args.head, args.merge_base,
        (branch or current) if args.head in (None, "HEAD") or args.base == "HEAD" else None,
    ])
    comparison = {
        "repo": str(repo), "base": args.base, "base_commit": base,
        "head": args.head, "head_commit": head, "merge_base": args.merge_base,
        "checkout_branch": branch.removeprefix("refs/heads/") or None, "captured_at": stamp(),
    }
    check_size(files)
    with object_reader(repo) as read_object:
        load_blobs(git, read_object, repo, files, bool(head))
    return scope, comparison, files


def patch_snapshot(path):
    path = path.resolve()
    content = path.read_bytes()
    files = []
    for patch in patch_sections(content):
        old, new, status = file_paths(patch)
        files.append(FileDiff(os.fsdecode(old) if old else None, os.fsdecode(new) if new else None, status, (patch,)))
    if content.strip() and not files:
        raise ValueError(f"No unified diff found in {path}")
    check_size(files)
    image_budget = ImageBudget()
    for file in files:
        if file.binary:
            file.blobs = patch_blobs(file, image_budget)
    return json.dumps(["patch", str(path)]), {"patch": str(path), "captured_at": stamp()}, files


def build(file):
    """Return the rows the page shows for one file, and the lines hidden in its gaps, compressed.

    The page asks for a file's hidden lines when the reviewer first expands one of its gaps.
    """
    shown, hidden = [], []
    for row in file.render():
        if row["kind"] == "gap":
            hidden.append({key: row.pop(key) for key in ("text", "html", "no_newline") if key in row})
        shown.append(row)
    packed = json.dumps(hidden, separators=(",", ":")).encode()
    return shown, gzip.compress(packed, compresslevel=1) if hidden else None


def render(files):
    """Build every file, across CPU cores when there is enough to highlight to repay starting them.

    Workers return hidden lines already compressed, so the server never holds them all at once.
    """
    order = sorted(files, key=lambda file: file.highlight_cost, reverse=True)
    workers = min(os.cpu_count() or 1, len(order), sum(file.highlight_cost for file in order) // HIGHLIGHT_WORKER_LOAD)
    if workers > 1:
        with ProcessPoolExecutor(workers, initializer=end_with_server) as pool:
            # A worker needs the diff and the text, not the image previews.
            built = list(pool.map(build, [replace(file, blobs={}) for file in order]))
    else:
        built = [build(file) for file in order]
    for file, (file.rendered, file.hidden) in zip(order, built):
        file.sources = {}


def snapshot(args):
    """Capture the comparison and build every file's view, so the page needs nothing more from Git."""
    scope, comparison, files = patch_snapshot(args.patch) if args.patch else git_snapshot(args)
    files.sort(key=lambda item: (item.path, item.change))
    render(files)
    return scope, comparison, files


def embed(value):
    """Encode JSON for an HTML data block, where a literal "<" could end the block."""
    return json.dumps(value, separators=(",", ":")).replace("<", "\\u003c").encode()


def annotation(file, target):
    side = target.get("side")
    if side not in ("old", "new"):
        raise ValueError("Select code from one side of the diff")
    side_line = f"{side}_line"

    def coordinates(position):
        row, column = position.get("row"), position.get("column")
        if type(row) is not int or type(column) is not int or row < 0:
            raise ValueError("Invalid selection coordinates")
        return row, column

    first, last = coordinates(target.get("start") or {}), coordinates(target.get("end") or {})
    if first > last:
        raise ValueError("Select some code before commenting")
    rows = list(file.selected_rows(first[0], last[0] + 1))

    def endpoint(position, source):
        row, column = position
        if source["index"] != row:
            raise ValueError("Invalid selection coordinates")
        if source.get(side_line) is None or not 1 <= column <= len(source["text"].encode("utf-16-le")) // 2 + 1:
            raise ValueError("Selection must be inside a code line")
        return {"row": row, "column": column, "old_line": source["old_line"], "new_line": source["new_line"]}

    if not rows:
        raise ValueError("Invalid selection coordinates")
    start, end = endpoint(first, rows[0]), endpoint(last, rows[-1])
    if first == last and rows[0]["text"]:
        raise ValueError("Select some code before commenting")
    contents = []
    for row in rows:
        if row.get(side_line) is not None:
            content = row["text"].encode("utf-16-le")
            left = 2 * (start["column"] - 1) if row["index"] == start["row"] else 0
            right = 2 * (end["column"] - 1) if row["index"] == end["row"] else len(content)
            contents.append(content[left:right].decode("utf-16-le", errors="surrogatepass"))
    return {"side": side, "start": start, "end": end, "selected_text": "\n".join(contents)}


def connect(state):
    database = sqlite3.connect(state / "review.sqlite3")
    database.execute("""CREATE TABLE IF NOT EXISTS reviewed (
        scope TEXT, file TEXT, version TEXT, PRIMARY KEY (scope, file, version)
    )""")
    database.execute("""CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL
    )""")
    return database


class Review:
    def __init__(self, args):
        from pygments.formatters import HtmlFormatter

        self.state = args.state_dir
        self.session = args.session
        self.expires_at = None
        self.scope, comparison, self.files = snapshot(args)
        self.assets = {name: ("text/javascript", (ASSETS / name).read_bytes())
                       for name in ("review.js", "images.js")}
        self.assets["review.css"] = "text/css", ((ASSETS / "review.css").read_bytes() +
                                                  HtmlFormatter(nobackground=True).get_style_defs(".source").encode())
        # Everything is built here. The page holds the diffs and each request adds the reviewer's progress;
        # a file's hidden lines wait, compressed, until the reviewer first expands one of its gaps.
        parts = (ASSETS / "review.html").read_bytes().split(b"REVIEW_STATE")
        if len(parts) != 2 or parts[0].count(b"REVIEW_SNAPSHOT") != 1:
            raise ValueError("review.html is missing its data blocks")
        self.hidden = {f"file/{index}/hidden": file.hidden for index, file in enumerate(self.files) if file.hidden}
        diffs = embed({"comparison": comparison, "files": [
            {**file.metadata(), **file.line_counts, "rows": file.rendered, "media": describe(file)}
            for file in self.files
        ]})
        self.document = parts[0].replace(b"REVIEW_SNAPSHOT", diffs), parts[1]
        payload = {"session": self.session, "comparison": comparison, "comments": {}}
        with closing(connect(self.state)) as db, db:
            db.execute("INSERT INTO sessions VALUES (?, 'pending', ?)", (self.session, json.dumps(payload)))

    def load(self, db):
        status, raw = db.execute("SELECT status, payload FROM sessions WHERE id = ?", (self.session,)).fetchone()
        return status, json.loads(raw)

    def asset(self, route):
        if route in self.assets:
            return self.assets[route]
        if route in self.hidden:
            return "application/json", gzip.decompress(self.hidden[route])
        index, _, side = route.removeprefix("file/").partition("/image/")
        if route.startswith("file/") and side in ("old", "new"):
            file = self.file(index)
            blob = file.blobs.get(side)
            if blob is not None and blob.content is not None:
                return image_type(getattr(file, f"{side}_path")), blob.content
        raise KeyError(route)

    def page(self, db):
        status, payload = self.load(db)
        if status != "pending":
            raise ValueError("This review has ended")
        progress = embed({
            "expires_at": self.expires_at, "comments": list(payload["comments"].values()),
            "reviewed": [file["reviewed"] for file in self.file_statuses(db)],
        })
        before, after = self.document
        return "text/html", before + progress + after

    def file(self, index):
        if not (isinstance(index, str) and index.isascii() and index.isdecimal() and int(index) < len(self.files)):
            raise ValueError("Unknown file in this review")
        return self.files[int(index)]

    def file_statuses(self, db):
        reviewed = set(db.execute("SELECT file, version FROM reviewed WHERE scope = ?", (self.scope,)))
        return [
            {**file.metadata(), **file.line_counts, "reviewed": (file.key, file.version) in reviewed}
            for file in self.files
        ]

    def post(self, db, route, data):
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        status, payload = self.load(db)
        if status != "pending":
            raise ValueError("This review has ended")
        if route == "reviewed":
            flag = data.get("reviewed")
            if type(flag) is not bool:
                raise ValueError("Expected a reviewed checkbox value")
            indices = data["files"] if "files" in data else [data.get("file")]
            if not isinstance(indices, list) or not indices or len(indices) > len(self.files):
                raise ValueError("Select one or more files to mark")
            files = [self.file(index) for index in indices]
            db.executemany(
                "INSERT OR IGNORE INTO reviewed VALUES (?, ?, ?)" if flag else
                "DELETE FROM reviewed WHERE scope = ? AND file = ? AND version = ?",
                ((self.scope, file.key, file.version) for file in files),
            )
            return {"reviewed": flag}
        comments = payload["comments"]
        if route == "comment":
            body = data.get("body")
            body = body.strip() if isinstance(body, str) else ""
            if not body or len(body) > 12000:
                raise ValueError("Enter a comment of up to 12,000 characters")
            if data.get("id"):
                comment = comments[data["id"]]
                comment.update(body=body, updated_at=stamp())
            else:
                index = data.get("file")
                file = self.file(index)
                key = secrets.token_hex(12)
                if "selection" not in data:
                    raise ValueError("Specify an inline selection or a file comment")
                selection = data["selection"]
                anchor = {"scope": "file"} if selection is None else annotation(file, selection)
                comment = {"id": key, "file": index, **file.metadata(), "body": body,
                           "created_at": stamp(), **anchor}
                comments[key] = comment
            self.save(db, status, payload)
            return comment
        if route == "delete":
            if not isinstance(data.get("id"), str):
                raise ValueError("Specify a comment to delete")
            comments.pop(data["id"], None)
            self.save(db, status, payload)
            return {}
        if route in ("submit", "cancel"):
            return self.finish(db, "submitted" if route == "submit" else "cancelled", payload)
        raise KeyError(route)

    def save(self, db, status, payload):
        db.execute("UPDATE sessions SET status = ?, payload = ? WHERE id = ?", (status, json.dumps(payload), self.session))

    def finish(self, db, status, payload):
        payload.update(ended_at=stamp(), files=self.file_statuses(db))
        self.save(db, status, payload)
        return {"status": status}


def share_tailnet(stack, server, origins, prefix, interrupted):
    from concurrent.futures import ThreadPoolExecutor

    for attempt in range(2):
        private = Tailnet.load()
        origins[urlsplit(private.origin).netloc] = private.origin
        with ExitStack() as startup:
            owner = startup.enter_context(private.start(server.server_port))
            with ThreadPoolExecutor(max_workers=1) as executor:
                ready = executor.submit(private.verify, owner, prefix, interrupted)
                while not ready.done():
                    server.handle_request()
                try:
                    ready.result()
                except ValueError:
                    if attempt or interrupted.is_set() or owner.poll() is None or not private.port_in_use():
                        raise
                else:
                    stack.enter_context(startup.pop_all())
                    return private.origin, owner
        del origins[urlsplit(private.origin).netloc]


class ReviewServer(ThreadingHTTPServer):
    # A page load opens more than the default backlog of 5 connections at once.
    request_queue_size = 128


def owner_path(state, session):
    key = hashlib.sha256(session.encode()).hexdigest()
    return state / f"{key}.lock"


def serve(args):
    # A kernel lock identifies the worker without depending on PID reuse or uptime.
    with owner_path(args.state_dir, args.session).open("xb") as ownership:
        fcntl.flock(ownership, fcntl.LOCK_EX)
        serve_owned(args)


def serve_owned(args):
    from threading import Event, Lock

    # Until the review exists there is nothing to close, so a signal during the build ends the worker at once.
    review = Review(args)
    interrupted = Event()
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, lambda *_: interrupted.set())
    lock = Lock()
    completed = Event()
    prefix = f"/{review.session}/"

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, response):
            if isinstance(response, tuple):
                mime, data = response
            else:
                mime, data = "application/json", json.dumps(response).encode()
            self.send_response(code)
            if not mime.startswith("image/") and "gzip" in self.headers.get("Accept-Encoding", ""):
                data = gzip.compress(data, compresslevel=1)
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Type", f"{mime}; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Security-Policy", "default-src 'none'; sandbox" if mime.startswith("image/") else CSP)
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def handle_request(self):
            path = urlsplit(self.path).path
            origin = origins.get(self.headers.get("Host"))
            if not origin or not path.startswith(prefix):
                self.send(404, {"error": "Review not found"})
                return
            route = path.removeprefix(prefix)
            if self.command == "GET" and route == "ready":
                self.send(200, ("text/plain", prefix.encode()))
                return
            try:
                if self.command == "POST":
                    length = int(self.headers.get("Content-Length", "0"))
                    if self.headers.get("Origin") != origin or self.headers.get_content_type() != "application/json":
                        self.send(403, {"error": "Open the review URL directly to submit changes"})
                        return
                    if not 0 < length <= 256 * 1024:
                        raise ValueError("Invalid or oversized request")
                    data = json.loads(self.rfile.read(length))
                if self.command == "GET" and route:
                    response = review.asset(route)
                else:
                    with lock, closing(connect(review.state)) as db, db:
                        response = review.page(db) if self.command == "GET" else review.post(db, route, data)
            except KeyError:
                self.send(404, {"error": "Unknown review item"})
                return
            except (ValueError, TypeError, AttributeError) as error:
                self.send(400, {"error": str(error)})
                return
            except sqlite3.Error as error:
                print(f"Review storage failed: {error}", file=sys.stderr, flush=True)
                self.send(500, {"error": "Could not save review state. Retry or inspect the session log."})
                return
            except (OSError, subprocess.SubprocessError) as error:
                print(f"Review data unavailable: {error}", file=sys.stderr, flush=True)
                self.send(500, {"error": "Review data unavailable. See the session log."})
                return
            try:
                self.send(200, response)
            finally:
                if route in ("submit", "cancel"):
                    completed.set()

        do_GET = do_POST = handle_request

        def log_message(self, _format, *_args):
            pass

    end_status = "interrupted"
    try:
        with ReviewServer(("127.0.0.1", 0), Handler) as server, ExitStack() as routes:
            host = f"127.0.0.1:{server.server_port}"
            local = f"http://{host}"
            origins = {host: local}
            server.timeout = 0.5
            public, sharing = share_tailnet(routes, server, origins, prefix, interrupted) if args.tailscale else (local, None)
            if interrupted.is_set():
                return
            review.expires_at = (datetime.now(timezone.utc) + timedelta(seconds=LIFETIME)).isoformat(timespec="seconds")
            print(json.dumps({"url": f"{public}{prefix}", "session": args.session, "files": len(review.files)}), flush=True)
            deadline = time.monotonic() + LIFETIME
            while (not completed.is_set() and not interrupted.is_set() and time.monotonic() < deadline
                   and (not sharing or sharing.poll() is None)):
                server.handle_request()
            if not completed.is_set() and not interrupted.is_set():
                if sharing and sharing.poll() is not None:
                    raise ValueError("Tailscale Serve stopped before the review finished")
                end_status = "expired"
    finally:
        with lock, closing(connect(review.state)) as db, db:
            status, payload = review.load(db)
            if status == "pending":
                review.finish(db, end_status, payload)


def start(args):
    if args.merge_base and not args.head:
        raise ValueError("--merge-base requires --head")
    if args.patch and (args.base != "HEAD" or args.head or args.merge_base):
        raise ValueError("--patch cannot be combined with Git revision options")
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    session = secrets.token_hex(16)
    log_path = args.state_dir / f"{session}.log"
    command = [sys.executable, __file__, "--state-dir", str(args.state_dir), "_serve"]
    if args.patch:
        command.extend(("--patch", str(args.patch)))
    else:
        command.extend(("--repo", str(args.repo or Path.cwd()), f"--base={args.base}"))
    if args.head:
        command.append(f"--head={args.head}")
    if args.merge_base:
        command.append("--merge-base")
    if args.tailscale:
        command.append("--tailscale")
    with log_path.open("xb") as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=log, start_new_session=True)
    with process.stdin as handoff:
        try:
            handoff.write(f"{session}\n".encode())
            handoff.flush()
        except BrokenPipeError:
            pass
    # The worker answers once every diff is built and the page is reachable, or it exits with the reason logged.
    with process.stdout as output:
        # Highlighting workers inherit this pipe, so only the worker's own exit shows that no answer is coming.
        while not select.select([output], [], [], 0.2)[0] and process.poll() is None:
            pass
        line = output.readline() if select.select([output], [], [], 0)[0] else b""
    if not line:
        status = process.wait()
        stopped = f"The review worker was stopped by signal {-status}. " if status < 0 else ""
        raise ValueError(f"Could not start the review. {stopped}{log_path.read_text().strip()} (log: {log_path})")
    print(line.decode().strip())

def result(args):
    if not (args.state_dir / "review.sqlite3").is_file():
        raise ValueError(f"No review state found in {args.state_dir}")
    query = "SELECT status, payload FROM sessions WHERE id = ?"
    with closing(connect(args.state_dir)) as db, db:
        row = db.execute(query, (args.session,)).fetchone()
        if row is None:
            raise ValueError(f"Unknown review session {args.session}")
        status, raw = row
        if status == "pending" and (path := owner_path(args.state_dir, args.session)).is_file():
            with path.open("rb") as ownership:
                try:
                    fcntl.flock(ownership, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    status, raw = db.execute(query, (args.session,)).fetchone()
                    if status == "pending":
                        status = "interrupted"
                        db.execute("UPDATE sessions SET status = ? WHERE id = ?", (status, args.session))
    payload = json.loads(raw)
    if status == "submitted":
        payload["comments"] = list(payload["comments"].values())
    else:
        stored = payload.pop("comments")
        if args.include_unsubmitted:
            payload["unsubmitted_comments"] = list(stored.values())
    print(json.dumps({"status": status, **payload}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    state_home = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    parser.add_argument("--state-dir", type=Path, default=state_home / "code-review",
                        help="Override the default state directory (XDG_STATE_HOME/code-review or ~/.local/state/code-review)")
    commands = parser.add_subparsers(dest="command", required=True, metavar="{start,result}")
    launch = commands.add_parser("start", help="Launch a background review and print its URL and session ID",
                                 epilog="Requires Python 3.10+ with Pygments. Git is required for repository comparisons.")
    worker = commands.add_parser("_serve")
    for command in (launch, worker):
        source = command.add_mutually_exclusive_group()
        source.add_argument("--repo", type=Path, help="Git checkout to review (default: current directory)")
        source.add_argument("--patch", type=Path, help="Standalone unified diff or Git patch file")
        command.add_argument("--base", default="HEAD", help="Baseline Git revision (default: HEAD)")
        command.add_argument("--head", help="Compare this Git revision instead of the working tree")
        command.add_argument("--merge-base", action="store_true", help="Compare from the merge base of --base and --head")
        command.add_argument("--tailscale", action="store_true", help="Share privately on the tailnet over HTTPS using Tailscale Serve")
    worker.add_argument("--session")
    read = commands.add_parser("result", help="Print the review status and submitted comments as JSON")
    read.add_argument("session", help="Session ID returned by start")
    read.add_argument("--include-unsubmitted", action="store_true", help="Return saved comments separately when a review was not submitted")
    args = parser.parse_args()
    args.state_dir = args.state_dir.resolve()
    try:
        if args.command == "_serve" and args.session is None:
            args.session = sys.stdin.readline().strip()
            if not re.fullmatch(r"[0-9a-f]{32}", args.session):
                raise ValueError("Invalid review worker session")
        {"start": start, "_serve": serve, "result": result}[args.command](args)
    except ModuleNotFoundError as error:
        if error.name == "pygments":
            parser.exit(1, "code_review.py: Python package Pygments is required for syntax highlighting.\n")
        raise
    except (OSError, subprocess.SubprocessError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"code_review.py: {error}\n")


if __name__ == "__main__":
    main()
