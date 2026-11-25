"""Own a private foreground Tailscale Serve route for one review."""

import http.client
import json
import os
import select
import signal
import socket
import ssl
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

COMMAND_TIMEOUT = 8
VERIFY_TIMEOUT = 55


def configuration(*args):
    result = subprocess.run(["tailscale", *args, "--json"], text=True, capture_output=True, timeout=COMMAND_TIMEOUT)
    if result.returncode:
        raise ValueError(f"Tailscale {' '.join(args)} failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def occupied(config):
    ports = set(map(int, (config.get("TCP") or {}).keys()))
    for session in (config.get("Foreground") or {}).values():
        ports.update(occupied(session))
    return ports


@dataclass
class Tailnet:
    hostname: str
    address: str
    port: int

    @property
    def origin(self):
        return f"https://{self.hostname}:{self.port}"

    def port_in_use(self):
        return self.port in occupied(configuration("serve", "status") or {})

    @classmethod
    def load(cls):
        status = configuration("status")
        peer = status.get("Self") or {}
        hostname = (peer.get("DNSName") or "").rstrip(".").lower()
        addresses = peer.get("TailscaleIPs") or []
        if status.get("BackendState") != "Running" or not addresses:
            raise ValueError("Connect Tailscale before using --tailscale")
        if not hostname or hostname not in {name.lower() for name in status.get("CertDomains") or []}:
            raise ValueError("--tailscale requires MagicDNS and HTTPS certificates on this tailnet")
        used = occupied(configuration("serve", "status") or {})
        port = next((port for port in range(8443, 8475) if port not in used), None)
        if port is None:
            raise ValueError("No available Tailscale Serve HTTPS port in 8443–8474")
        return cls(hostname, addresses[0], port)

    @contextmanager
    def start(self, local_port):
        # EOF on the pipe stops the owner even if the review worker is killed.
        with subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(self.port), str(local_port)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, start_new_session=True,
        ) as owner:
            try:
                yield owner
            finally:
                owner.stdin.close()
                owner.wait(timeout=10)

    def verify(self, owner, prefix, interrupted):
        deadline = time.monotonic() + VERIFY_TIMEOUT
        context = ssl.create_default_context()
        last_error = "startup timed out"
        while owner.poll() is None and time.monotonic() < deadline and not interrupted.is_set():
            try:
                with socket.create_connection((self.address, self.port), 3) as link:
                    with context.wrap_socket(link, server_hostname=self.hostname) as secure:
                        secure.sendall(f"GET {prefix}ready HTTP/1.1\r\nHost: {self.hostname}:{self.port}\r\nConnection: close\r\n\r\n".encode())
                        response = http.client.HTTPResponse(secure)
                        response.begin()
                        if response.status == 200 and response.read(len(prefix) + 1) == prefix.encode():
                            return
            except (OSError, http.client.HTTPException) as error:
                last_error = str(error)
            else:
                last_error = f"HTTP {response.status} or unexpected response"
            time.sleep(0.2)
        if interrupted.is_set():
            raise ValueError("Review startup was interrupted")
        raise ValueError("Tailscale Serve stopped before readiness. See the session log."
                         if owner.poll() is not None else f"Could not verify private HTTPS: {last_error}")


def own(port, local_port):
    process = subprocess.Popen(
        ["tailscale", "serve", "--bg=false", f"--https={port}", f"http://127.0.0.1:{local_port}"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        while process.poll() is None:
            if select.select([sys.stdin], [], [], 0.2)[0]:
                break
    finally:
        if process.poll() is None:
            # Where "tailscale" is a wrapper script, the process that holds the route is its child.
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    return process.returncode


if __name__ == "__main__":
    sys.exit(own(*map(int, sys.argv[1:])))
