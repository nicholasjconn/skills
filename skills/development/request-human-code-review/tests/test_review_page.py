import argparse
import functools
import gzip
import json
import os
import signal
import time
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "code_review.py"
SNAPSHOT = re.compile(rb'<script id="review-snapshot" type="application/json">(.*?)</script>', re.DOTALL)
STATE = re.compile(rb'<script id="review-state" type="application/json">(.*?)</script>', re.DOTALL)


class ReviewPage(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        self.repo = root / "repo"
        self.state = root / "state"
        self.repo.mkdir()
        self.git("init", "-q")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "change")

    def tool(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), "--state-dir", str(self.state), *args],
                              capture_output=True, text=True)

    def start(self, *args, source=None):
        started = self.tool("start", *(source or ("--repo", str(self.repo))), *args)
        self.assertEqual(started.returncode, 0, started.stderr)
        review = json.loads(started.stdout)
        self.addCleanup(self.post, review["url"], "cancel", {}, check=False)
        return review

    def post(self, url, route, data, check=True):
        scheme, _, host, _ = url.split("/", 3)
        request = urllib.request.Request(url + route, data=json.dumps(data).encode(), headers={
            "Content-Type": "application/json", "Origin": f"{scheme}//{host}"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except OSError:
            if check:
                raise

    def page(self, url):
        with urllib.request.urlopen(url, timeout=30) as response:
            document = response.read()
        snapshot, progress = json.loads(SNAPSHOT.search(document)[1]), json.loads(STATE.search(document)[1])
        return {file["path"]: file for file in snapshot["files"]}, progress

    def hidden(self, url, files, path):
        """A file's hidden lines, as the page asks for them when the reviewer first expands one of its gaps."""
        with urllib.request.urlopen(f"{url}file/{list(files).index(path)}/hidden", timeout=30) as response:
            return json.load(response)

    @staticmethod
    def side(rows, side, hidden=()):
        """The lines of one version of the file, read back from the page's rows and the file's hidden lines."""
        skipped = "add" if side == "old" else "remove"
        hidden = iter(hidden)
        lines = []
        for row in rows:
            if row["kind"] == "gap":
                lines.extend(next(hidden)["text"])
            elif row["kind"] in ("context", "add", "remove") and row["kind"] != skipped:
                lines.append(row["text"])
        return lines

    def test_page_holds_the_diff_and_each_file_hands_over_its_hidden_lines(self):
        before = [f"value_{number} = {number}" for number in range(1, 61)]
        before[28] = 'tag = "</script><!-- still data -->"'
        after = list(before)
        after[29] = "value_30 = 'changed'"
        (self.repo / "values.py").write_text("\n".join(before) + "\n")
        self.commit()
        (self.repo / "values.py").write_text("\n".join(after) + "\n")
        (self.repo / "added.py").write_text("new_value = 1\n")

        url = self.start()["url"]
        files, _ = self.page(url)

        self.assertEqual(sorted(files), ["added.py", "values.py"])
        rows = files["values.py"]["rows"]
        self.assertIn(before[28], [row["text"] for row in rows if row["kind"] == "context"])
        self.assertIn("<span", next(row["new_html"] for row in rows if row["kind"] == "add"))
        gaps = [row for row in rows if row["kind"] == "gap"]
        self.assertEqual([gap["count"] for gap in gaps], [26, 27])
        self.assertNotIn("value_50", json.dumps(files), "The page carries lines the reviewer has not asked to see")
        hidden = self.hidden(url, files, "values.py")
        self.assertEqual(self.side(rows, "old", hidden), before)
        self.assertEqual(self.side(rows, "new", hidden), after)
        self.assertEqual([len(lines["html"]) for lines in hidden], [26, 27])
        self.assertEqual(self.side(files["added.py"]["rows"], "new"), ["new_value = 1"])
        with self.assertRaises(urllib.error.HTTPError) as missing:
            self.hidden(url, files, "added.py")
        self.assertEqual(missing.exception.code, 404)

    def test_hidden_lines_of_a_file_without_a_final_newline_are_highlighted(self):
        lines = [f"value_{number} = {number}" for number in range(1, 31)]
        (self.repo / "values.py").write_text("\n".join(lines))
        self.commit()
        lines[1] = "value_2 = 'changed'"
        (self.repo / "values.py").write_text("\n".join(lines))

        url = self.start()["url"]
        files, _ = self.page(url)

        rows = files["values.py"]["rows"]
        hidden = self.hidden(url, files, "values.py")
        self.assertEqual(self.side(rows, "new", hidden), lines)
        self.assertEqual(rows[-1]["kind"], "gap")
        self.assertIs(hidden[-1].get("no_newline"), True)
        self.assertEqual(len(hidden[-1]["html"]), rows[-1]["count"])
        self.assertIn("<span", hidden[-1]["html"][-1])

    def test_a_file_over_the_highlight_limit_shows_its_changes_without_hidden_lines(self):
        (self.repo / "huge.py").write_text("".join(f"value_{number} = {number}\n" for number in range(40000)))
        self.commit()
        with (self.repo / "huge.py").open("a") as stream:
            stream.write("last_value = None\n")

        files, _ = self.page(self.start()["url"])

        rows = files["huge.py"]["rows"]
        self.assertEqual([row["kind"] for row in rows if row["kind"] == "gap"], [])
        self.assertIn("<span", next(row["new_html"] for row in rows if row["kind"] == "add"))

    def test_a_file_with_an_oversized_diff_is_listed_without_its_contents(self):
        (self.repo / "small.py").write_text("value = 1\n")
        (self.repo / "generated.json").write_text("".join(f'"key_{number}": {number},\n' for number in range(40000)))
        url = self.start()["url"]

        files, _ = self.page(url)

        generated = files["generated.json"]
        self.assertEqual((generated["additions"], generated["deletions"]), (40000, 0))
        self.assertEqual([row["kind"] for row in generated["rows"]], ["note"])
        self.assertIn("500 KiB limit", generated["rows"][0]["text"])
        self.assertEqual(self.side(files["small.py"]["rows"], "new"), ["value = 1"])
        index = sorted(files).index("generated.json")
        saved = self.post(url, "comment", {"file": str(index), "body": "Should this be committed?", "selection": None})
        self.assertEqual(saved["path"], "generated.json")

    def test_start_refuses_a_comparison_with_too_many_files(self):
        (self.repo / "first.txt").write_text("first\n")
        self.commit()
        for number in range(301):
            (self.repo / f"file_{number}.txt").write_text(f"{number}\n")
        self.commit()

        started = self.tool("start", "--repo", str(self.repo), "--base", "HEAD~1", "--head", "HEAD")

        self.assertNotEqual(started.returncode, 0)
        self.assertIn("301 changed files (limit 300)", started.stderr)

    def test_start_refuses_a_comparison_with_too_much_diff(self):
        for number in range(8):
            (self.repo / f"file_{number}.py").write_text("".join(f"value_{line} = {line}\n" for line in range(22000)))

        started = self.tool("start", "--repo", str(self.repo))

        self.assertNotEqual(started.returncode, 0)
        self.assertRegex(started.stderr, r"8 changed files \(limit 300\), 3\.\d MiB of diff \(limit 3 MiB\)")

    def test_start_refuses_a_comparison_with_too_many_lines_in_little_diff(self):
        for number in range(3):
            (self.repo / f"file_{number}.txt").write_text("\n" * 40000)

        started = self.tool("start", "--repo", str(self.repo))

        self.assertNotEqual(started.returncode, 0)
        self.assertRegex(started.stderr, r"0\.2 MiB of diff \(limit 3 MiB\) and 120,0\d\d diff lines \(limit 100,000\)")

    def test_a_server_killed_while_building_leaves_no_process_behind(self):
        for number in range(40):
            (self.repo / f"module_{number}.py").write_text("".join(f"value_{line} = {line}\n" for line in range(20000)))
        self.commit()
        for number in range(40):
            with (self.repo / f"module_{number}.py").open("a") as module:
                module.write("changed = True\n")

        def children(parent):
            listing = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
            rows = (line.split(None, 2) for line in listing.splitlines())
            return {int(pid) for pid, owner, command in rows if int(owner) == parent and "git" not in command}

        def alive(pids):
            listing = subprocess.run(["ps", "-axo", "pid=,stat="], capture_output=True, text=True).stdout
            rows = (line.split() for line in listing.splitlines())
            return {int(pid) for pid, state in rows if not state.startswith("Z")} & pids

        start = subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--state-dir", str(self.state), "start",
                                  "--repo", str(self.repo)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(start.communicate)
        deadline = time.monotonic() + 30
        server, workers = set(), set()
        while len(workers) < 2:
            self.assertIsNone(start.poll(), "The review started before any highlighting worker was seen")
            self.assertLess(time.monotonic(), deadline, "No highlighting workers were seen")
            server = server or children(start.pid)
            workers = children(next(iter(server))) if server else set()
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid in alive(workers)])

        os.kill(next(iter(server)), signal.SIGKILL)

        _, error = start.communicate(timeout=30)
        self.assertNotEqual(start.returncode, 0)
        self.assertIn("The review worker was stopped by signal 9.", error)
        deadline = time.monotonic() + 10
        while alive(workers) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(alive(workers), set(), "Highlighting workers outlived their server")

    def test_patch_file_is_reviewed_without_a_checkout(self):
        (self.repo / "values.py").write_text("first = 1\nsecond = 2\n")
        self.commit()
        (self.repo / "values.py").write_text("first = 1\nsecond = 'two'\n")
        patch = self.repo.parent / "change.patch"
        patch.write_bytes(subprocess.run(["git", "-C", str(self.repo), "diff"], check=True, capture_output=True).stdout)

        files, _ = self.page(self.start(source=("--patch", str(patch)))["url"])

        rows = files["values.py"]["rows"]
        self.assertEqual(self.side(rows, "new"), ["first = 1", "second = 'two'"])
        self.assertIn("<span", next(row["new_html"] for row in rows if row["kind"] == "add"))

    def test_page_is_compressed_only_for_a_client_that_accepts_it(self):
        (self.repo / "values.py").write_text("value = 1\n")
        url = self.start()["url"]

        def fetch(accepted):
            request = urllib.request.Request(url, headers={"Accept-Encoding": accepted})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.headers.get("Content-Encoding"), response.read()

        encoding, plain = fetch("identity")
        self.assertIsNone(encoding)
        self.assertIn(b"review-snapshot", plain)
        encoding, packed = fetch("gzip, br")
        self.assertEqual(encoding, "gzip")
        self.assertEqual(SNAPSHOT.search(gzip.decompress(packed))[1], SNAPSHOT.search(plain)[1])

    def test_large_files_are_highlighted(self):
        for name in ("first.py", "second.py"):
            (self.repo / name).write_text("".join(f"value_{number} = {number}\n" for number in range(12000)))
        self.commit()
        for name in ("first.py", "second.py"):
            with (self.repo / name).open("a") as stream:
                stream.write("last_value = None\n")

        url = self.start()["url"]
        files, _ = self.page(url)

        for name in ("first.py", "second.py"):
            rows = files[name]["rows"]
            hidden = self.hidden(url, files, name)
            self.assertIn("<span", next(row["new_html"] for row in rows if row["kind"] == "add"))
            self.assertEqual(len(self.side(rows, "new", hidden)), 12001)
            self.assertEqual([len(lines["html"]) for lines in hidden], [row["count"] for row in rows if row["kind"] == "gap"])

    def test_reviewer_progress_is_saved_as_it_is_made_and_returned(self):
        lines = [f"line {number}" for number in range(1, 41)]
        (self.repo / "notes.txt").write_text("\n".join(lines) + "\n")
        self.commit()
        lines[29] = "line 30 changed"
        (self.repo / "notes.txt").write_text("\n".join(lines) + "\n")
        review = self.start()
        url = review["url"]
        files, progress = self.page(url)
        self.assertEqual(progress["reviewed"], [False])
        hidden = files["notes.txt"]["rows"][0]
        self.assertEqual(hidden["kind"], "gap")

        row = hidden["index"] + 9  # line 10 is not shown until the reviewer expands the gap
        saved = self.post(url, "comment", {"file": "0", "body": "Why ten?", "selection": {
            "side": "new", "start": {"row": row, "column": 1}, "end": {"row": row, "column": 8}}})
        self.post(url, "reviewed", {"file": "0", "reviewed": True})

        self.assertEqual(saved["selected_text"], "line 10")
        _, progress = self.page(url)
        self.assertEqual(progress["reviewed"], [True])
        self.assertEqual([comment["body"] for comment in progress["comments"]], ["Why ten?"])
        drafts = json.loads(self.tool("result", review["session"], "--include-unsubmitted").stdout)
        self.assertEqual(drafts["status"], "pending")
        self.assertEqual([comment["body"] for comment in drafts["unsubmitted_comments"]], ["Why ten?"])

        self.post(url, "submit", {})

        result = json.loads(self.tool("result", review["session"]).stdout)
        self.assertEqual(result["status"], "submitted")
        comment, = result["comments"]
        self.assertEqual((comment["path"], comment["selected_text"], comment["end"]["new_line"]), ("notes.txt", "line 10", 10))
        self.assertEqual([file["reviewed"] for file in result["files"]], [True])

    def test_binary_and_image_files_report_sizes_and_serve_previews(self):
        old_image, new_image = b"\x89PNG old image", b"\x89PNG a newer image"
        (self.repo / "logo.png").write_bytes(old_image)
        (self.repo / "data.bin").write_bytes(b"\x00" * 10)
        self.commit()
        (self.repo / "logo.png").write_bytes(new_image)
        (self.repo / "data.bin").write_bytes(b"\x00" * 25)
        for committed in (False, True):
            with self.subTest(committed=committed):
                if committed:
                    self.commit()
                url = self.start(*(("--base", "HEAD~1", "--head", "HEAD") if committed else ()))["url"]
                files, _ = self.page(url)

                logo, data = files["logo.png"]["media"], files["data.bin"]["media"]
                self.assertEqual((logo["old"]["size"], logo["new"]["size"]), (len(old_image), len(new_image)))
                self.assertEqual((data["binary"], data["old"]["size"], data["new"]["size"]), (True, 10, 25))
                index = sorted(files).index("logo.png")
                for side, content in (("old", old_image), ("new", new_image)):
                    with urllib.request.urlopen(f"{url}file/{index}/image/{side}", timeout=30) as response:
                        self.assertEqual(response.read(), content)

    def test_start_reports_why_a_review_could_not_start(self):
        started = self.tool("start", "--repo", str(self.repo), "--base", "no-such-revision")

        self.assertNotEqual(started.returncode, 0)
        self.assertIn("git rev-parse failed", started.stderr)

    def scripts(self):
        sys.path.insert(0, str(SCRIPT.parent))
        self.addCleanup(sys.path.remove, str(SCRIPT.parent))
        import code_review
        import media
        return code_review, media

    def test_image_previews_spend_the_size_budget_in_file_order(self):
        code_review, media = self.scripts()
        kilobyte = 1024
        self.addCleanup(setattr, media, "ImageBudget", media.ImageBudget)
        media.ImageBudget = functools.partial(media.ImageBudget, 128 * kilobyte)
        committed = {"a.png": 30, "b.png": 30, "c.png": 30, "d.png": 30, "e.png": 20}
        for name, size in committed.items():
            (self.repo / name).write_bytes(name.encode() * (size * kilobyte // len(name)))
        self.commit()
        for name, size in {"a.png": 30, "b.png": 15, "c.png": 30, "d.png": 30}.items():
            (self.repo / name).write_bytes(b"new " + name.encode() * (size * kilobyte // len(name) - 1))
        (self.repo / "e.png").unlink()

        arguments = argparse.Namespace(patch=None, repo=self.repo, base="HEAD", head=None, merge_base=False)
        _, _, files = code_review.snapshot(arguments)

        previews = {file.path: [side for side in ("old", "new") if media.describe(file)[side]["image"]] for file in files}
        # a and b use 105 of 128 KiB. c and d no longer fit; the smaller e still does.
        self.assertEqual(previews, {"a.png": ["old", "new"], "b.png": ["old", "new"], "c.png": [], "d.png": [], "e.png": ["old"]})

    def test_git_is_launched_the_same_number_of_times_however_many_files_changed(self):
        commands = self.repo.parent / "bin"
        commands.mkdir()
        launches = self.repo.parent / "git-launches"
        (commands / "git").write_text(f'#!/bin/sh\necho launched >> "{launches}"\nexec "{shutil.which("git")}" "$@"\n')
        (commands / "git").chmod(0o755)
        environment = {**os.environ, "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}"}

        def git_launches(changed, committed):
            for number in range(changed):
                (self.repo / f"file_{number}.py").write_text(f"value = {number}\n")
            self.commit()
            for number in range(changed):
                (self.repo / f"file_{number}.py").write_text(f"value = {number + 100}\n")
            source = ["--repo", str(self.repo)]
            if committed:
                self.commit()
                source += ["--base", "HEAD~1", "--head", "HEAD"]
            launches.write_text("")
            started = subprocess.run([sys.executable, "-B", str(SCRIPT), "--state-dir", str(self.state), "start", *source],
                                     capture_output=True, text=True, env=environment)
            self.assertEqual(started.returncode, 0, started.stderr)
            review = json.loads(started.stdout)
            self.post(review["url"], "cancel", {})
            self.assertEqual(review["files"], changed)
            return len(launches.read_text().splitlines())

        for committed in (False, True):
            with self.subTest(committed=committed):
                few, many = git_launches(3, committed), git_launches(40, committed)
                self.assertGreater(few, 0)
                self.assertEqual(few, many)

if __name__ == "__main__":
    unittest.main()
