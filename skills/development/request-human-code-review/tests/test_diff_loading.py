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
FILES = 96


def changed_repository(root):
    repo = root / "repo"
    repo.mkdir()
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}

    def git(*args):
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgsign=false", *args], check=True, capture_output=True, timeout=60, env=env)

    git("init", "-q")
    for index in range(FILES):
        (repo / f"file-{index}.txt").write_text("before\n")
    git("add", ".")
    git("commit", "-qm", "fixture")
    for index in range(FILES):
        (repo / f"file-{index}.txt").write_text(f"after {index}\n")
    return repo


class DiffLoading(unittest.TestCase):
    def test_every_diff_loads_when_all_are_requested_at_once(self):
        # The detached worker may still be closing its state when the test ends.
        scratch = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        started = subprocess.run([sys.executable, "-B", str(SCRIPT), "--state-dir", str(root / "state"), "start",
                                  "--repo", str(changed_repository(root))],
                                 check=True, capture_output=True, text=True, timeout=120)
        review = json.loads(started.stdout)
        self.addCleanup(self.cancel, review["url"])
        self.assertEqual(review["files"], FILES)
        together = threading.Barrier(FILES)
        outcomes = [None] * FILES

        def load(index):
            try:
                together.wait(timeout=60)
                with urllib.request.urlopen(f"{review['url']}file/{index}", timeout=30) as response:
                    outcomes[index] = bool(json.load(response)["rows"])
            except Exception as error:
                outcomes[index] = repr(error)

        requests = [threading.Thread(target=load, args=(index,)) for index in range(FILES)]
        for request in requests:
            request.start()
        for request in requests:
            request.join()
        self.assertEqual(outcomes, [True] * FILES)

    def cancel(self, url):
        origin = url.split("/", 3)
        request = urllib.request.Request(f"{url}cancel", data=b"{}", headers={
            "Content-Type": "application/json", "Origin": f"{origin[0]}//{origin[2]}"})
        urllib.request.urlopen(request, timeout=30).close()


if __name__ == "__main__":
    unittest.main()
