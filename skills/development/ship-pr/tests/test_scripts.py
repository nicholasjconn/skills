"""Run with python3 -B -m unittest discover -s tests -v from the skill directory."""

import errno
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def environment(self, fixture=None, **values):
        tools = []
        for tool in ("bash", "jq"):
            executable = shutil.which(tool)
            self.assertIsNotNone(executable, f"required test tool missing: {tool}")
            tools.append(str(Path(executable).parent))
        if fixture:
            tools.insert(0, str(self.root / "bin"))
            (self.root / "bin").mkdir(exist_ok=True)
            shutil.copyfile(HERE / "fixtures" / fixture, self.root / "bin" / "gh")
            (self.root / "bin" / "gh").chmod(0o700)
        # Exclude caller credentials, shell startup hooks and GitHub configuration.
        return {
            "PATH": os.pathsep.join([*tools, "/usr/bin", "/bin"]),
            "HOME": str(self.root),
            "TMPDIR": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "LC_ALL": "C",
            "TZ": "UTC",
            **values,
        }

    def run_script(self, script, env, *args):
        with subprocess.Popen(
            [shutil.which("bash"), str(SCRIPTS / script), *args],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        ) as process:
            try:
                stdout, stderr = process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=2)
                raise
            return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)

    def reader(self, mode="ok", **values):
        return self.environment("reader.sh", GH_STUB_MODE=mode, **values)

    def test_reader_requires_repo_and_pr(self):
        for args, message in [
            ([], "--repo must be in owner/name form"),
            (["--repo", "not-a-repo", "--pr", "1"], "--repo must be in owner/name form"),
            (["--repo", "o/n", "--pr", "x"], "--pr must be a numeric PR number"),
            (["--repo"], "--repo requires a value"),
        ]:
            with self.subTest(args=args):
                result = self.run_script("read-pr-comments.sh", self.environment(), *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_reader_renders_kinds_pagination_replies_and_quoting(self):
        result = self.run_script("read-pr-comments.sh", self.reader(), "--repo", "acme/widgets", "--pr", "7")
        self.assertEqual(result.returncode, 0, result.stderr)
        for fragment in [
            "# PR comments for acme/widgets #7", "## conversation", "- Author: alex",
            "- ID: 1", "- URL: https://example.test/issue/1",
            "> Conversation $(whoami)", "> > quoted", "- Author: blair", "> (empty)",
            "## review", "- Author: casey", "- Review state: CHANGES_REQUESTED", "> Needs work",
            "## inline", "- Author: riley", "- ID: 11",
            "- Thread: resolved=true; outdated=false", "- Path: internal/widget.go",
            "- Line: 42", "- Side: RIGHT", "- Review ID: 21", "> Please fix this",
            "## inline-reply", "- Author: sam", "- Reply to: 11", "> Done",
            "- ID: 13", "- Thread: resolved=false; outdated=true", "> Still open",
        ]:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, result.stdout)
        self.assertEqual(result.stdout.count("## inline\n"), 2)
        self.assertEqual(result.stdout.count("## inline-reply\n"), 1)

    def test_reader_fails_on_api_and_malformed_json(self):
        for mode in ("fail", "malformed"):
            with self.subTest(mode=mode):
                result = self.run_script("read-pr-comments.sh", self.reader(mode), "--repo", "acme/widgets", "--pr", "7")
                self.assertNotEqual(result.returncode, 0)
                if mode == "fail":
                    self.assertIn("boom", result.stderr)

    def test_reader_handles_forced_terminal_output(self):
        result = self.run_script(
            "read-pr-comments.sh", self.reader(GH_FORCE_TTY="120", CLICOLOR_FORCE="1"),
            "--repo", "acme/widgets", "--pr", "7",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("> Please fix this", result.stdout)
        self.assertNotIn("\x1b", result.stdout)

    def test_reader_uses_tools_outside_system_path(self):
        tools = self.root / "tools"
        tools.mkdir()
        for tool in ("bash", "jq"):
            executable = shutil.which(tool)
            self.assertIsNotNone(executable, f"required test tool missing: {tool}")
            (tools / tool).symlink_to(executable)
        with mock.patch.dict(os.environ, PATH=str(tools)):
            result = self.run_script("read-pr-comments.sh", self.reader(), "--repo", "o/n", "--pr", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Please fix this", result.stdout)

    def watcher(self, first, second, comments=None, next_comments=None, **values):
        files = {}
        for name, data in [
            ("pr1", first), ("pr2", second),
            ("comments1", [] if comments is None else comments),
            ("comments2", comments if next_comments is None and comments is not None else next_comments or []),
        ]:
            path = self.root / (name + ".json")
            path.write_text(json.dumps(data))
            files[name] = str(path)
        counter = self.root / "count"
        counter.unlink(missing_ok=True)
        return self.environment(
            "watcher.sh", GH_STUB_MODE="ok", GH_STUB_COUNT_FILE=str(counter),
            GH_STUB_PR_STATE_1=files["pr1"], GH_STUB_PR_STATE_2=files["pr2"],
            GH_STUB_COMMENTS_1=files["comments1"], GH_STUB_COMMENTS_2=files["comments2"],
            **values,
        )

    def watch_args(self, log, *extra):
        return ["--repo", "acme/widgets", "--pr", "7", "--log-file", str(log),
                "--interval-seconds", "1", *extra]

    def watch_once(self, env, log, *extra):
        result = self.run_script("watch-pr-events.sh", env, *self.watch_args(log, "--exit-on-change", *extra))
        self.assertEqual(result.returncode, 0, result.stderr)
        event = json.loads(result.stdout)
        self.assertTrue(log.read_text().endswith(result.stdout))
        return event

    def watch_running(self, env, log):
        # Own the process group so timeout/cleanup cannot leave a polling child.
        with tempfile.TemporaryFile(mode="w+") as stderr:
            process = subprocess.Popen(
                [shutil.which("bash"), str(SCRIPTS / "watch-pr-events.sh"), *self.watch_args(log)],
                env=env, stdout=subprocess.DEVNULL, stderr=stderr, start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    self.assertIsNone(process.poll(), "watcher exited before logging")
                    if log.exists():
                        line, separator, _ = log.read_text().partition("\n")
                        if separator and line:
                            return json.loads(line)
                    time.sleep(0.02)
                stderr.seek(0)
                self.fail("timed out waiting for watcher: " + stderr.read())
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=2)

    def test_watcher_requires_repo_pr_and_log_file(self):
        for args, message in [
            ([], "--repo must be in owner/name form"),
            (["--repo", "o/n", "--pr", "1"], "--log-file is required"),
        ]:
            with self.subTest(args=args):
                result = self.run_script("watch-pr-events.sh", self.environment(), *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def snapshots(self, padding=""):
        common = {"mergeable": "MERGEABLE", "comments": [{"body": padding}] if padding else [],
                  "reviews": [], "statusCheckRollup": []}
        return (
            dict(common, headRefOid="abc", reviewDecision="REVIEW_REQUIRED", updatedAt="2026-01-01T00:00:00Z"),
            dict(common, headRefOid="def", reviewDecision="APPROVED", updatedAt="2026-01-01T00:01:00Z"),
        )

    def test_watcher_logs_state_changes(self):
        event = self.watch_running(
            self.watcher(*self.snapshots(), comments=[{"id": 11, "body": "please fix"}]),
            self.root / "events.jsonl",
        )
        self.assertEqual(event["repo"], "acme/widgets")
        self.assertEqual(event["pr"], 7)
        self.assertEqual(event["state"]["pull_request"]["headRefOid"], "def")
        self.assertEqual(len(event["state"]["inline_comments"]), 1)

    def test_watcher_survives_payloads_too_large_for_argjson(self):
        maximum = 3 << 20
        try:
            arg_max = int(subprocess.check_output(["getconf", "ARG_MAX"], env=self.environment()))
            size = min(maximum, arg_max + (256 << 10)) if arg_max >= 1 << 20 else maximum
        except (OSError, ValueError, subprocess.CalledProcessError):
            size = maximum
        first, second = self.snapshots("x" * size)
        env = self.watcher(first, second, comments=[{"id": 11, "body": "x" * size}],
                           next_comments=[{"id": 12, "body": "x" * size}])
        try:
            result = subprocess.run(
                ["jq", "-n", "--argjson", "pr_state", json.dumps(first), "$pr_state"],
                env=self.environment(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=8,
            )
        except OSError as error:
            if error.errno != errno.E2BIG:
                raise
        else:
            if result.returncode == 0:
                self.skipTest("OS argument limit accepts the practical 3 MiB fixture")
            self.fail("jq failed for a reason other than the OS argument limit")
        event = self.watch_running(env, self.root / "events.jsonl")
        self.assertEqual(event["state"]["pull_request"]["headRefOid"], "def")
        self.assertEqual(len(event["state"]["inline_comments"]), 1)

    def test_watcher_fails_on_api_error(self):
        env = self.watcher({}, {})
        env["GH_STUB_MODE"] = "fail"
        result = self.run_script("watch-pr-events.sh", env, *self.watch_args(self.root / "events.jsonl"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("boom", result.stderr)

    def test_watcher_wakes_for_edits_and_arbitrary_checks(self):
        for change in ("inline edit", "review edit", "required check"):
            with self.subTest(change=change):
                first = {"headRefOid": "abc", "reviews": [{"id": 21, "body": "initial"}],
                         "statusCheckRollup": [{"name": "custom-required-check", "status": "IN_PROGRESS"}]}
                second = json.loads(json.dumps(first))
                comments, next_comments = [{"id": 11, "body": "initial"}], [{"id": 11, "body": "initial"}]
                if change == "inline edit":
                    next_comments[0]["body"] = "corrected finding"
                elif change == "review edit":
                    second["reviews"][0]["body"] = "corrected finding"
                else:
                    second["statusCheckRollup"] = [{"name": "custom-required-check", "status": "COMPLETED", "conclusion": "SUCCESS"}]
                env = self.watcher(first, second, comments, next_comments, GH_FORCE_TTY="120", CLICOLOR_FORCE="1")
                event = self.watch_once(env, self.root / (change + ".jsonl"))
                self.assertEqual(event["reason"], "state-change")

    def test_watcher_deadline_wakes_without_changes(self):
        created = int(time.time())
        first = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)), "headRefOid": "abc"}
        event = self.watch_once(self.watcher(first, first), self.root / "events.jsonl",
                                "--interval-seconds", "60", "--review-deadline-seconds", "2")
        self.assertEqual(event["reason"], "review-deadline")
        self.assertEqual(event["review_deadline_epoch"], created + 2)
        self.assertGreaterEqual(time.time(), created + 2)

    def test_watcher_does_not_repeat_expired_deadline_on_restart(self):
        first = {"createdAt": "2026-01-01T00:00:00Z", "headRefOid": "abc"}
        second = dict(first, headRefOid="def")
        log = self.root / "events.jsonl"
        event = self.watch_once(self.watcher(first, first), log,
                                "--interval-seconds", "60", "--review-deadline-seconds", "600")
        self.assertEqual(event["reason"], "review-deadline")
        event = self.watch_once(self.watcher(second, second), log,
                                "--interval-seconds", "60", "--review-deadline-seconds", "600")
        self.assertEqual(event["reason"], "state-change")
        event = self.watch_once(self.watcher(second, first), log, "--review-deadline-seconds", "600")
        self.assertEqual(event["reason"], "state-change")
        self.assertEqual(log.read_text().count("\n"), 3)
