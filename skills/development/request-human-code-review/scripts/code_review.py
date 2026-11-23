#!/usr/bin/env python3
"""Open a code diff snapshot for interactive browser review."""

import argparse
import hashlib
import json
import os
import re
import secrets
import select
import sqlite3
import subprocess
import sys
import time
from contextlib import closing, nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import cached_property
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import islice
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
from media import ImageBudget, describe, git_blobs, image_type, patch_blobs
from patch_input import DIFF_HEADER, HUNK, file_paths, patch_sections
from tailnet import Tailnet

ASSETS = Path(__file__).resolve().parent
LIFETIME = 12 * 3600
GIT_DIFF = (
    "--patch", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv",
    "--no-relative", "--submodule=short", "--ignore-submodules=dirty", "-U3",
    "--src-prefix=a/", "--dst-prefix=b/", "--word-diff=none",
    "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
)
BINARY_NOTE = re.compile(rb"^(GIT binary patch|Binary files .* differ)\r?$", re.MULTILINE)
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"


def git(repo, *args, allowed=(0,), input_bytes=None):
    process = subprocess.run(
        ["git", "--no-optional-locks", "-c", "diff.suppressBlankEmpty=false", "-C", repo, *args], input=input_bytes,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        env={**os.environ, "LC_ALL": "C"},
    )
    if process.returncode not in allowed:
        error = process.stderr.decode(errors="replace").strip()
        raise ValueError(f"git {args[0]} failed in {repo}: {error or process.returncode}")
    return process.stdout


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def display(data):
    return data.decode("utf-8", errors="replace")


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
    repo: Path | None = None
    committed: bool = False

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
    def line_counts(self):
        return {
            "additions": sum(row["kind"] == "add" for row in self.rows),
            "deletions": sum(row["kind"] == "remove" for row in self.rows),
        }

    @cached_property
    def rows(self):
        rows = []
        for patch in self.patches:
            in_hunk = False
            for line in patch.split(b"\n"):
                if line.startswith(b"diff --git "):
                    continue
                if BINARY_NOTE.fullmatch(line):
                    break
                match = HUNK.match(line)
                if match:
                    old, new = int(match[1]), int(match[3])
                    in_hunk = True
                    rows.append({"kind": "hunk", "text": display(line.removesuffix(b"\r")),
                                 "old_range": display(match[0].split(b" ")[1]),
                                 "new_range": display(match[0].split(b" ")[2])})
                elif in_hunk and line[:1] in (b"+", b"-", b" "):
                    indicator = line[:1]
                    rows.append({
                        "kind": {b"+": "add", b"-": "remove", b" ": "context"}[indicator],
                        "old_line": old if indicator != b"+" else None,
                        "new_line": new if indicator != b"-" else None,
                        "text": display(line[1:].removesuffix(b"\r")),
                    })
                    old += indicator != b"+"
                    new += indicator != b"-"
                elif in_hunk and line.startswith(b"\\ No newline at end of file") and "old_line" in rows[-1]:
                    rows[-1]["no_newline"] = True
                elif line and not line.startswith((b"index ", b"--- ", b"+++ ", b"similarity index ")):
                    rows.append({"kind": "note", "text": display(line)})
        if not rows:
            rows.append({"kind": "note", "text": "No textual changes"})
        return rows

    @cached_property
    def rendered(self):
        from pygments import highlight
        from pygments.formatters import HtmlFormatter
        from pygments.lexers import get_lexer_for_filename
        from pygments.util import ClassNotFound

        def markup_lines(path, source):
            try:
                lexer = get_lexer_for_filename(path, source, stripnl=False, ensurenl=False)
            except ClassNotFound:
                return []
            return highlight(source, lexer, HtmlFormatter(nowrap=True)).split("\n")

        rows = [dict(row) for row in self.rows]
        hunks = list(split_hunks(rows))
        sources = {}
        if self.repo and hunks:
            try:
                sources = git_blobs(git, self.repo, self, self.committed)
            except (OSError, ValueError):
                # Source files can change or disappear after the diff was captured.
                pass
        for side, path in (("old", self.old_path), ("new", self.new_path)):
            if path is None:
                continue
            line_key = f"{side}_line"
            html_key = f"{side}_html"
            blob = sources.get(side)
            if blob is not None and blob.content is not None:
                source = display(blob.content).replace("\r\n", "\n").replace("\r", "\n")
                source_lines = source.split("\n")
                highlighted = markup_lines(path, source)
                if len(highlighted) == len(source_lines):
                    for row in rows:
                        line = row.get(line_key)
                        if line is not None and 0 < line <= len(highlighted) and source_lines[line - 1] == row["text"]:
                            row[html_key] = highlighted[line - 1]
                    continue
            # Patches may contain only the hunks. Keep the two lexer states separate.
            for hunk in hunks:
                code_rows = [row for row in hunk if row.get(line_key) is not None]
                if not code_rows:
                    continue
                source = "\n".join(row["text"] for row in code_rows) + "\n"
                highlighted = markup_lines(path, source)
                if len(highlighted) == len(code_rows) + 1:
                    for row, markup in zip(code_rows, highlighted):
                        row[html_key] = markup
        return rows


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
        for raw_path in git(repo, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0"):
            if not raw_path:
                continue
            path = os.fsdecode(raw_path)
            if path.endswith("/"):
                raise ValueError(f"Untracked nested repository {path!r}. Add or ignore it before reviewing.")
            patch = git(repo, "diff", "--no-index", *GIT_DIFF, "--", os.devnull, path, allowed=(0, 1))
            if not patch.startswith(b"diff --git "):
                raise ValueError(f"Git returned no patch for untracked file {path!r}")
            files.append(FileDiff(None, path, "?", (patch,)))
    scope = json.dumps([
        str(repo), args.base, args.head, args.merge_base,
        (branch or current) if args.head in (None, "HEAD") or args.base == "HEAD" else None,
    ])
    comparison = {
        "repo": str(repo), "base": args.base, "base_commit": base,
        "head": args.head, "head_commit": head, "merge_base": args.merge_base,
        "checkout_branch": branch.removeprefix("refs/heads/") or None, "captured_at": stamp(),
    }
    image_budget = ImageBudget()
    for file in files:
        file.repo = repo
        file.committed = bool(head)
        if file.binary or image_type(file.old_path) or image_type(file.new_path):
            file.blobs = git_blobs(git, repo, file, bool(head), image_budget=image_budget)
    return scope, comparison, files


def patch_snapshot(path):
    path = path.resolve()
    content = path.read_bytes()
    files = []
    image_budget = ImageBudget()
    for patch in patch_sections(content):
        old, new, status = file_paths(patch)
        file = FileDiff(os.fsdecode(old) if old else None, os.fsdecode(new) if new else None, status, (patch,))
        if file.binary:
            file.blobs = patch_blobs(file, image_budget)
        files.append(file)
    if content.strip() and not files:
        raise ValueError(f"No unified diff found in {path}")
    return json.dumps(["patch", str(path)]), {"patch": str(path), "captured_at": stamp()}, files


def snapshot(args):
    scope, comparison, files = patch_snapshot(args.patch) if args.patch else git_snapshot(args)
    return scope, comparison, sorted(files, key=lambda item: (item.path, item.change))


def annotation(file, target):
    side = target.get("side")
    if side not in ("old", "new"):
        raise ValueError("Select code from one side of the diff")
    side_line = f"{side}_line"

    def endpoint(position):
        row, column = position["row"], position["column"]
        if type(row) is not int or type(column) is not int or not 0 <= row < len(file.rows):
            raise ValueError("Invalid selection coordinates")
        source = file.rows[row]
        if source.get(side_line) is None or not 1 <= column <= len(source["text"].encode("utf-16-le")) // 2 + 1:
            raise ValueError("Selection must be inside a code line")
        return {"row": row, "column": column, "old_line": source["old_line"], "new_line": source["new_line"]}

    start, end = endpoint(target["start"]), endpoint(target["end"])
    if (start["row"], start["column"]) >= (end["row"], end["column"]):
        raise ValueError("Select some code before commenting")
    contents = []
    for row_index in range(start["row"], end["row"] + 1):
        row = file.rows[row_index]
        if row.get(side_line) is not None:
            content = row["text"].encode("utf-16-le")
            first = 2 * (start["column"] - 1) if row_index == start["row"] else 0
            last = 2 * (end["column"] - 1) if row_index == end["row"] else len(content)
            contents.append(content[first:last].decode("utf-16-le", errors="surrogatepass"))
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
        self.scope, comparison, self.files = snapshot(args)
        self.assets = {name: ("text/javascript", (ASSETS / name).read_bytes())
                       for name in ("review.js", "images.js")}
        self.assets[""] = "text/html", (ASSETS / "review.html").read_bytes()
        self.assets["review.css"] = "text/css", ((ASSETS / "review.css").read_bytes() +
                                                  HtmlFormatter(nobackground=True).get_style_defs(".source").encode())
        payload = {"session": self.session, "comparison": comparison, "comments": {}}
        with closing(connect(self.state)) as db, db:
            db.execute("INSERT INTO sessions VALUES (?, 'pending', ?)", (self.session, json.dumps(payload)))

    def load(self, db):
        status, raw = db.execute("SELECT status, payload FROM sessions WHERE id = ?", (self.session,)).fetchone()
        return status, json.loads(raw)

    def get_snapshot(self, route):
        if route in self.assets:
            return self.assets[route]
        if route.startswith("file/"):
            index, *asset = route.removeprefix("file/").split("/")
            file = self.file(index)
            if not asset:
                return {"rows": file.rendered, "media": describe(file)}
            if len(asset) == 2 and asset[0] == "image" and asset[1] in ("old", "new"):
                side = asset[1]
                blob = file.blobs.get(side)
                if blob is not None and blob.content is not None:
                    return image_type(getattr(file, f"{side}_path")), blob.content
        raise KeyError(route)

    def get_data(self, db):
        status, payload = self.load(db)
        if status != "pending":
            raise ValueError("This review has ended")
        return {"comparison": payload["comparison"], "files": self.file_statuses(db),
                "comments": list(payload["comments"].values())}

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
        status, payload = self.load(db)
        if status != "pending":
            raise ValueError("This review has ended")
        if route == "reviewed":
            file = self.file(data["file"])
            flag = data["reviewed"]
            if type(flag) is not bool:
                raise ValueError("Expected a reviewed checkbox value")
            db.execute(
                "INSERT OR IGNORE INTO reviewed VALUES (?, ?, ?)" if flag else
                "DELETE FROM reviewed WHERE scope = ? AND file = ? AND version = ?",
                (self.scope, file.key, file.version),
            )
            return {"reviewed": flag}
        comments = payload["comments"]
        if route == "comment":
            body = data["body"].strip()
            if not body or len(body) > 12000:
                raise ValueError("Enter a comment of up to 12,000 characters")
            if data.get("id"):
                comment = comments[data["id"]]
                comment.update(body=body, updated_at=stamp())
            else:
                index = data["file"]
                file = self.file(index)
                key = secrets.token_hex(12)
                comment = {"id": key, "file": index, **file.metadata(), "body": body,
                           "created_at": stamp(), **annotation(file, data["selection"])}
                comments[key] = comment
            self.save(db, status, payload)
            return comment
        if route == "delete":
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


def serve(args):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock

    private = Tailnet.load() if args.tailscale else None
    review = Review(args)
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
                if self.command == "GET" and route != "data":
                    response = review.get_snapshot(route)
                else:
                    with lock, closing(connect(review.state)) as db, db:
                        response = review.get_data(db) if self.command == "GET" else review.post(db, route, data)
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
            try:
                self.send(200, response)
            finally:
                if route in ("submit", "cancel"):
                    completed.set()

        do_GET = do_POST = handle_request

        def log_message(self, _format, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        host = f"127.0.0.1:{server.server_port}"
        local = f"http://{host}"
        origins = {host: local}
        public = private.origin if private else local
        server.timeout = 0.5
        if private:
            origins[urlsplit(public).netloc] = public
        with private.start(server.server_port) if private else nullcontext() as sharing:
            if private:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    ready = executor.submit(private.verify, sharing, prefix)
                    while not ready.done():
                        server.handle_request()
                    ready.result()
            print(json.dumps({"url": f"{public}{prefix}", "session": args.session, "files": len(review.files)}), flush=True)
            deadline = time.monotonic() + LIFETIME
            while not completed.is_set() and time.monotonic() < deadline and (not sharing or sharing.poll() is None):
                server.handle_request()
            stopped = sharing and sharing.poll() is not None and not completed.is_set()
            with lock, closing(connect(review.state)) as db, db:
                status, payload = review.load(db)
                if status == "pending":
                    review.finish(db, "interrupted" if stopped else "expired", payload)
            if stopped:
                raise ValueError("Tailscale Serve stopped before the review finished")


def start(args):
    if args.merge_base and not args.head:
        raise ValueError("--merge-base requires --head")
    if args.patch and (args.base != "HEAD" or args.head or args.merge_base):
        raise ValueError("--patch cannot be combined with Git revision options")
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    session = secrets.token_hex(16)
    log_path = args.state_dir / f"{session}.log"
    command = [sys.executable, __file__, "--state-dir", str(args.state_dir), "_serve", "--session", session]
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
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=log, start_new_session=True)
    with process.stdout as output:
        if select.select([output], [], [], 75 if args.tailscale else 45)[0]:
            line = output.readline()
            if line:
                print(line.decode().strip())
                return
        else:
            process.terminate()
            raise ValueError(f"Review startup timed out. See {log_path}")
    raise ValueError(f"Could not start the review. {log_path.read_text().strip()} (log: {log_path})")


def result(args):
    if not (args.state_dir / "review.sqlite3").is_file():
        raise ValueError(f"No review state found in {args.state_dir}")
    with closing(connect(args.state_dir)) as db:
        row = db.execute("SELECT status, payload FROM sessions WHERE id = ?", (args.session,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown review session {args.session}")
    status, raw = row
    payload = json.loads(raw)
    if status == "submitted":
        payload["comments"] = list(payload["comments"].values())
    else:
        del payload["comments"]
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
    worker.add_argument("--session", required=True)
    read = commands.add_parser("result", help="Print the review status and submitted comments as JSON")
    read.add_argument("session", help="Session ID returned by start")
    args = parser.parse_args()
    args.state_dir = args.state_dir.resolve()
    try:
        {"start": start, "_serve": serve, "result": result}[args.command](args)
    except ModuleNotFoundError as error:
        if error.name == "pygments":
            parser.exit(1, "code_review.py: Python package Pygments is required for syntax highlighting.\n")
        raise
    except (OSError, subprocess.TimeoutExpired, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"code_review.py: {error}\n")


if __name__ == "__main__":
    main()
