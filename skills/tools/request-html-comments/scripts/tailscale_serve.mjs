import { execFile, spawn } from 'node:child_process'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const delay = ms => new Promise(resolveDelay => { setTimeout(resolveDelay, ms).unref() })
const SCRIPT = fileURLToPath(import.meta.url)

async function configuration(...args) {
  try {
    const { stdout } = await execute('tailscale', args, { timeout: 8000, maxBuffer: 1_000_000 })
    return JSON.parse(stdout)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('--tailscale requires the Tailscale CLI on PATH')
    throw new Error(`Tailscale ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`)
  }
}

function occupiedPorts(config, result = new Set()) {
  for (const port of Object.keys(config?.TCP || {})) result.add(Number(port))
  for (const session of Object.values(config?.Foreground || {})) occupiedPorts(session, result)
  return result
}

export async function prepareTailscaleServe(requestedPort = null) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('--tailscale supports Linux and macOS')
  const status = await configuration('status', '--json')
  if (status.BackendState !== 'Running') throw new Error('Tailscale must be connected before starting a private review')
  const name = String(status.Self?.DNSName || '').replace(/\.$/, '').toLowerCase()
  if (!name || !status.CertDomains?.some(domain => domain.toLowerCase() === name)) {
    throw new Error('Enable MagicDNS and HTTPS certificates for this tailnet before using --tailscale')
  }
  const address = status.Self?.TailscaleIPs?.find(value => isIP(value))
  if (!address) throw new Error('Tailscale did not report a device IP address')
  const ports = occupiedPorts(await configuration('serve', 'status', '--json'))
  const port = requestedPort ?? Array.from({ length: 32 }, (_, index) => 8443 + index).find(value => !ports.has(value))
  if (!port || ports.has(port)) throw new Error(`Tailscale HTTPS port ${port || 'allocation'} is occupied; choose another --tailscale-port`)
  return { port, address, origin: `https://${name}${port === 443 ? '' : `:${port}`}` }
}

function readReady(url, endpoint, address) {
  const target = new URL(`${endpoint}/ready`, url)
  return new Promise((resolveRead, rejectRead) => {
    // Connect directly to the discovered IP, retaining certificate verification
    // and the public SNI/Host even when this machine does not use MagicDNS.
    const call = request(target, { hostname: address, servername: target.hostname, headers: { host: target.host }, timeout: 5000 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        if (body.length > endpoint.length) call.destroy(new Error('Unexpected private readiness response'))
      })
      response.on('error', rejectRead)
      response.on('end', () => response.statusCode === 200 && body === endpoint
        ? resolveRead() : rejectRead(new Error(`Private HTTPS readiness failed (HTTP ${response.statusCode})`)))
    })
    call.on('timeout', () => call.destroy(new Error('Private HTTPS readiness timed out')))
    call.on('error', rejectRead)
    call.end()
  })
}

// This IPC child owns foreground Serve. Worker death closes IPC, so even
// SIGKILL releases its session rather than exposing a reused backend port.
export async function startTailscaleServe({ port, address, localPort, reviewUrl, endpoint, log }) {
  const child = spawn(process.execPath, [SCRIPT, '--session', String(port), String(localPort)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let failure = null
  let stopping = false
  let diagnostics = ''
  let resolveFailure
  const failed = new Promise(resolveFailed => { resolveFailure = resolveFailed })
  const markFailure = error => {
    if (stopping || failure) return
    failure = error
    resolveFailure(error)
  }
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000) })
  const exited = new Promise(resolveExit => {
    child.once('error', error => { markFailure(error); resolveExit() })
    child.once('exit', (code, exitSignal) => {
      markFailure(new Error(`Tailscale Serve stopped unexpectedly (${exitSignal || code}): ${diagnostics.trim()}`))
      resolveExit()
    })
  })
  let closing
  const close = () => closing ??= (async () => {
    stopping = true
    if (child.connected) child.disconnect()
    await Promise.race([exited, delay(9000).then(() => { throw new Error('Tailscale Serve session did not stop') })])
    log('info', 'Private Tailscale Serve session stopped', { https_port: port })
  })()
  try {
    const deadline = Date.now() + 60_000
    let lastError
    while (Date.now() < deadline) {
      if (failure) throw failure
      try {
        await readReady(reviewUrl, endpoint, address)
        if (failure) throw failure
        log('info', 'Private HTTPS review verified', { review_url: reviewUrl, https_port: port })
        return { failed, close }
      } catch (error) {
        lastError = error
        if (failure) throw failure
      }
      await delay(200)
    }
    throw new Error(`Could not verify private HTTPS review: ${lastError?.message || 'startup timed out'}`)
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}; Serve cleanup failed: ${cleanupError.message}`) }
    throw error
  }
}

async function ownSession(port, localPort) {
  let stopping = false
  const child = spawn('tailscale', ['serve', '--bg=false', `--https=${port}`, `http://127.0.0.1:${localPort}`], {
    // A CLI may be a shell wrapper: own its process group as well.
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const exited = new Promise(resolveExit => child.once('close', (code, exitSignal) => {
    resolveExit()
    if (!stopping) {
      process.stderr.write(`Tailscale Serve failed (${exitSignal || code})\n`)
      void stop(1)
    }
  }))
  child.once('error', error => {
    process.stderr.write(`${error.message}\n`)
    void stop(1)
  })
  const signalSession = signal => {
    if (!child.pid) return false
    try { process.kill(-child.pid, signal); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  const stop = async (code = 0) => {
    if (stopping) return
    stopping = true
    if (signalSession('SIGINT')) {
      // Keep this timer referenced: redirected descendants may leave no other
      // handles after the wrapper closes and the worker disconnects.
      const grace = new Promise(resolveGrace => setTimeout(resolveGrace, 3000))
      await Promise.race([exited, grace])
      if (signalSession(0)) await grace
      signalSession('SIGKILL')
      await exited
    }
    process.exit(code)
  }
  process.once('disconnect', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  if (!process.connected) await stop()
}

if (resolve(process.argv[1] || '') === resolve(SCRIPT) && process.argv[2] === '--session') {
  const port = Number(process.argv[3])
  const localPort = Number(process.argv[4])
  if (![port, localPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) {
    throw new Error('Invalid internal Serve session ports')
  }
  await ownSession(port, localPort)
}
