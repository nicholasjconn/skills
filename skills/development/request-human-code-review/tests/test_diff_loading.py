import json
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "code_review.py"
SESSION = "0" * 32
FILES = 96


def changed_repository(root, count):
    repo = root / "repo"
    repo.mkdir()

    def git(*args):
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        *args], check=True, capture_output=True, timeout=60)

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
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.repo = changed_repository(self.root, FILES)
        (self.root / "state").mkdir()
        self.state = ["--state-dir", str(self.root / "state")]

    def test_every_diff_loads_when_the_page_requests_them_all_at_once(self):
        started = subprocess.run([sys.executable, "-B", str(SCRIPT), *self.state, "start", "--repo", str(self.repo)],
                                 check=True, capture_output=True, text=True, timeout=120)
        review = json.loads(started.stdout)
        self.addCleanup(self.cancel, review["url"])
        self.assertEqual(review["files"], FILES)
        together = threading.Barrier(FILES)
        outcomes = [None] * FILES

        def load(index):
            together.wait()
            try:
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

    def test_a_diff_that_cannot_be_built_stops_startup_before_a_url_is_shared(self):
        broken = ("import sys; sys.path.insert(0, sys.argv.pop(1)); import code_review\n"
                  "def describe(_file): raise ValueError('diff cannot be built')\n"
                  "code_review.describe = describe; code_review.main()")
        worker = subprocess.run([sys.executable, "-B", "-c", broken, str(SCRIPT.parent), *self.state, "_serve",
                                 "--repo", str(self.repo), "--session", SESSION],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(worker.stdout.strip(), "")
        self.assertNotEqual(worker.returncode, 0)
        self.assertIn("diff cannot be built", worker.stderr)

    def cancel(self, url):
        origin = url.split("/", 3)
        request = urllib.request.Request(f"{url}cancel", data=b"{}", headers={
            "Content-Type": "application/json", "Origin": f"{origin[0]}//{origin[2]}"})
        urllib.request.urlopen(request, timeout=30).close()


if __name__ == "__main__":
    unittest.main()
