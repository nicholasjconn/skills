# Networking

## Private HTTPS with Tailscale

For review from another tailnet device or a trusted HTTPS context, prefer
Tailscale Serve when installed, connected, and HTTPS is enabled for the tailnet.
On Linux, this mode requires normal kernel networking; userspace-only Tailscale
networking does not provide the local listener needed for HTTPS verification.
Use `--tailscale` on Linux or macOS:

```bash
SCRIPT="<skill-directory>/scripts/html_review.mjs"
node "$SCRIPT" /absolute/path/to/page.html --tailscale --async \
  --output /absolute/path/to/result.json
```

`--tailscale-port PORT` requests a specific unused HTTPS port; `--port` controls
the separate local listener. Do not use Funnel, reset Serve, replace an existing
route, or combine this mode with `--host` or direct TLS flags.

The CLI binds its local listener to loopback and verifies HTTPS before
reporting readiness. Give the user the returned URL. Their other device must
be connected to the tailnet and permitted by its access rules. Tailnet peers with access can read
the allowed file tree or use the proxied application's routes and WebSockets.
The DNS hostname appears in public certificate logs; the content stays private.

If Tailscale is unavailable, report that the normal loopback URL works only on
this computer. Once `--tailscale` is selected, startup failures are fatal; do
not silently switch to a local URL. Missing login, HTTPS enablement, or device
enrollment is a setup prerequisite, not permission to perform that setup.

## Trusted LAN

For a trusted-LAN review, `--host IPV4` accepts only an active, non-loopback
IPv4 address assigned to this machine. The server binds and advertises only that
address, never `0.0.0.0`. The review server has no authentication: any LAN peer
that reaches that interface can access the entire allowed file tree or, for
loopback URL sources, proxy arbitrary routes, methods, bodies, and WebSockets to
the local app. Use this mode only with the user's authorization and an
appropriately trusted network.

Pages that need a secure context on the LAN (e.g. `Secure` cookies,
`crypto.randomUUID`) can be reviewed over HTTPS: pass `--tls-cert PATH` and
`--tls-key PATH` (PEM files whose certificate names the review host, e.g.
`subjectAltName=IP:<host>`). Use a certificate trusted by the reviewing device
for reliable secure-context behavior. Keep the key outside a reviewed file's
directory, which the review serves in full; the CLI rejects keys inside that
tree, including symlinked paths.
