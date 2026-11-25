import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TAILNET = Path(__file__).resolve().parents[1] / "scripts" / "tailnet.py"


def running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class TailscaleRoute(unittest.TestCase):
    def test_ending_a_review_stops_the_program_behind_a_wrapper_command(self):
        """On macOS the tailscale command can be a script that starts the program holding the route."""
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        program = root / "program"
        program.write_text('#!/bin/sh\necho $$ > "$PID_FILE"\nexec sleep 300\n')
        wrapper = root / "tailscale"
        wrapper.write_text(f'#!/bin/sh\n"{program}" "$@"\n')
        for script in (program, wrapper):
            script.chmod(0o755)
        environment = {**os.environ, "PATH": f"{root}{os.pathsep}{os.environ['PATH']}", "PID_FILE": str(root / "pid")}
        owner = subprocess.Popen([sys.executable, "-B", str(TAILNET), "8443", "1"], stdin=subprocess.PIPE, env=environment)
        deadline = time.monotonic() + 10
        while not (root / "pid").exists() or not (root / "pid").read_text().strip():
            self.assertLess(time.monotonic(), deadline, "The route program did not start")
            time.sleep(0.05)
        pid = int((root / "pid").read_text())
        self.addCleanup(lambda: running(pid) and os.kill(pid, signal.SIGKILL))

        owner.stdin.close()  # the review worker ending the route
        owner.wait(timeout=30)

        deadline = time.monotonic() + 5
        while running(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(running(pid), "The program holding the route outlived the review")


if __name__ == "__main__":
    unittest.main()
