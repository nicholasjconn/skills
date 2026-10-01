import { execFile, spawn } from 'node:child_process'
import { request } from 'node:https'
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
  for (const port of Object.keys(config.TCP || {})) result.add(Number(port))
  for (const session of Object.values(config.Foreground || {})) occupiedPorts(session, result)
  return result
}

export async function prepareTailscaleServe(requestedPort = null) {
  const status = await configuration('status', '--json')
  if (status.BackendState !== 'Running') throw new Error('Tailscale must be connected before starting a private review')
  const name = String(status.Self?.DNSName || '').replace(/\.$/, '').toLowerCase()
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(name)) throw new Error('Tailscale did not report a valid device DNS name')
  if (!status.CertDomains?.some(domain => domain.toLowerCase() === name)) {
    throw new Error('Enable HTTPS certificates for this tailnet before using --tailscale')
  }
  const ports = occupiedPorts(await configuration('serve', 'status', '--json'))
  const port = requestedPort ?? Array.from({ length: 32 }, (_, index) => 8443 + index).find(value => !ports.has(value))
  if (!port || ports.has(port)) throw new Error(`Tailscale HTTPS port ${port || 'allocation'} is occupied; choose another --tailscale-port`)
  return { port, origin: `https://${name}${port === 443 ? '' : `:${port}`}` }
}

function readReview(url, endpoint) {
  return new Promise((resolveRead, rejectRead) => {
    const call = request(url, { timeout: 5000 }, response => {
      let tail = ''
      let verified = false
      response.setEncoding('utf8')
      response.on('data', chunk => {
        tail += chunk
        verified ||= tail.includes(JSON.stringify(endpoint))
        tail = tail.slice(-4096)
      })
      response.on('error', rejectRead)
      response.on('end', () => {
        if (response.statusCode !== 200 || !verified) {
          rejectRead(new Error(`Private HTTPS readiness failed (HTTP ${response.statusCode}); response was not this review`))
        } else resolveRead()
      })
    })
    call.on('timeout', () => call.destroy(new Error('Private HTTPS readiness timed out')))
    call.on('error', rejectRead)
    call.end()
  })
}

// This IPC child owns foreground Serve. Worker death closes IPC, so even
// SIGKILL releases its session rather than exposing a reused backend port.
export async function startTailscaleServe({ port, localPort, reviewUrl, endpoint, signal, log }) {
  if (occupiedPorts(await configuration('serve', 'status', '--json')).has(port)) {
    throw new Error(`Tailscale HTTPS port ${port} became occupied before startup`)
  }
  const child = spawn(process.execPath, [SCRIPT, '--session', String(port), String(localPort)], {
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
  child.on('message', message => {
    if (message.type === 'failed') markFailure(new Error(message.message))
  })
  child.once('error', markFailure)
  const exited = new Promise(resolveExit => child.once('exit', (code, exitSignal) => {
    markFailure(new Error(`Tailscale Serve stopped unexpectedly (${exitSignal || code}): ${diagnostics.trim()}`))
    resolveExit()
  }))
  let closing
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      stopping = true
      if (child.connected) child.send({ type: 'stop' })
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([exited, delay(9000).then(() => { throw new Error('Tailscale Serve session did not stop') })])
      }
      log('info', 'Private Tailscale Serve session stopped', { https_port: port })
    })()
    return closing
  }
  try {
    const deadline = Date.now() + 60_000
    let lastError
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Private review startup interrupted')
      if (failure) throw failure
      try {
        await readReview(reviewUrl, endpoint)
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
    await close()
    throw error
  }
}

async function ownSession(port, localPort) {
  let output = ''
  let stopping = false
  let closed = false
  const child = spawn('tailscale', ['serve', '--bg=false', `--https=${port}`, `http://127.0.0.1:${localPort}`], {
    // A CLI may be a shell wrapper: own its process group as well.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-16000) })
  const exited = new Promise(resolveExit => child.once('close', (code, exitSignal) => {
    closed = true
    if (!stopping && process.connected) process.send({ type: 'failed', message: `Tailscale Serve failed (${exitSignal || code}): ${output.trim()}` })
    resolveExit()
  }))
  child.once('error', error => {
    if (process.connected) process.send({ type: 'failed', message: error.message })
  })
  const signalSession = signal => {
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const stop = async () => {
    if (stopping) return
    stopping = true
    if (!closed) {
      signalSession('SIGINT')
      await Promise.race([exited, delay(3000)])
      if (!closed) {
        signalSession('SIGKILL')
        await exited
      }
    }
    process.exit(0)
  }
  process.on('message', message => { if (message.type === 'stop') void stop() })
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
