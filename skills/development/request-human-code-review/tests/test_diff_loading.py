import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "code_review.py"
SESSION = "0" * 32


def changed_repository(root, count):
    repo = root / "repo"
    repo.mkdir()
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}

    def git(*args):
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgsign=false", *args], check=True, capture_output=True, timeout=60, env=env)

    git("init", "-q")
    for index in range(count):
        (repo / f"file-{index}.txt").write_text("before\n")
    git("add", ".")
    git("commit", "-qm", "fixture")
    for index in range(count):
        (repo / f"file-{index}.txt").write_text(f"after {index}\n")
    return repo


class DiffLoading(unittest.TestCase):
    def setUp(self):
        # The detached worker may still be closing its state when a test ends.
        scratch = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / "state").mkdir()
        self.state = ["--state-dir", str(self.root / "state")]

    def test_every_diff_loads_when_all_are_requested_at_once(self):
        files = 96
        repo = changed_repository(self.root, files)
        started = subprocess.run([sys.executable, "-B", str(SCRIPT), *self.state, "start", "--repo", str(repo)],
                                 check=True, capture_output=True, text=True, timeout=120)
        review = json.loads(started.stdout)
        self.addCleanup(self.cancel, review["url"])
        self.assertEqual(review["files"], files)
        together = threading.Barrier(files)
        outcomes = [None] * files

        def load(index):
            together.wait()
            try:
                with urllib.request.urlopen(f"{review['url']}file/{index}", timeout=30) as response:
                    outcomes[index] = bool(json.load(response)["rows"])
            except Exception as error:
                outcomes[index] = repr(error)

        requests = [threading.Thread(target=load, args=(index,)) for index in range(files)]
        for request in requests:
            request.start()
        for request in requests:
            request.join()
        self.assertEqual(outcomes, [True] * files)

    def test_a_diff_that_cannot_be_built_stops_startup_and_names_the_file(self):
        repo = changed_repository(self.root, 2)
        broken = ("import sys; sys.path.insert(0, sys.argv.pop(1)); import code_review\n"
                  "def describe(file):\n"
                  "    if file.path == 'file-1.txt': raise TypeError('unreadable hunk')\n"
                  "    return {}\n"
                  "code_review.describe = describe; code_review.main()")
        worker = subprocess.run([sys.executable, "-B", "-c", broken, str(SCRIPT.parent), *self.state, "_serve",
                                 "--repo", str(repo), "--session", SESSION],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(worker.stdout, "")
        self.assertEqual(worker.returncode, 1)
        self.assertEqual(worker.stderr.strip(),
                         "code_review.py: Could not build the diff for file-1.txt: unreadable hunk")

    def cancel(self, url):
        origin = url.split("/", 3)
        request = urllib.request.Request(f"{url}cancel", data=b"{}", headers={
            "Content-Type": "application/json", "Origin": f"{origin[0]}//{origin[2]}"})
        urllib.request.urlopen(request, timeout=30).close()


if __name__ == "__main__":
    unittest.main()
