#!/usr/bin/env node

// Zero-dependency runtime for the portable skill. Keeping the local server,
// loopback proxy, and CLI lifecycle together makes the skill installable as a
// self-contained directory without a package manager or build step.

import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const REVIEW_SAFETY_TIMEOUT_MS = 12 * 60 * 60 * 1000
const FORCE_CLOSE_GRACE_MS = 250
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000

// Source identity is persisted with drafts and submissions so comments cannot
// be restored onto a different file or application route by accident.
function loopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(hostname)
}

function upstreamHostname(hostname) {
  return hostname === '[::1]' ? '::1' : hostname
}

function httpAuthority(hostname, port) {
  return Number(port) === 80 ? hostname : `${hostname}:${port}`
}

export function validateReviewHost(host, interfaces = networkInterfaces()) {
  if (typeof host !== 'string' || isIP(host) !== 4) {
    throw new Error('--host must be a non-loopback IPv4 address assigned to an active local interface')
  }
  const firstOctet = Number(host.split('.')[0])
  if (host === '0.0.0.0' || firstOctet === 127 || (firstOctet >= 224 && firstOctet <= 239)) {
    throw new Error('--host must be a non-loopback IPv4 address assigned to an active local interface')
  }
  const local = Object.values(interfaces).flat().some(address => (
    address && (address.family === 'IPv4' || address.family === 4)
    && !address.internal && address.address === host
  ))
  if (!local) throw new Error(`--host address ${host} is not assigned to an active local interface`)
  return host
}

export function sourceIdentity(source) {
  return { type: source.type, value: source.type === 'file' ? source.path : source.url.href }
}

export function parseSource(value, cwd = process.cwd()) {
  if (!value) throw new Error('source is required')
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !loopbackHostname(url.hostname)) {
      throw new Error('served-page source must be an http:// loopback URL')
    }
    return { type: 'url', url }
  }
  const path = resolve(cwd, value)
  if (!existsSync(path) || !statSync(path).isFile() || !['.html', '.htm'].includes(extname(path).toLowerCase())) {
    throw new Error('file source must be an existing .html or .htm file')
  }
  return { type: 'file', path }
}

export function normalizeRestoredSource(payload) {
  if (payload?.source && typeof payload.source === 'object') return payload.source
  if (typeof payload?.source === 'string') return { type: 'file', value: payload.source }
  if (typeof payload?.source_url === 'string') return { type: 'url', value: payload.source_url }
  return null
}

function validCommentList(comments) {
  return Array.isArray(comments) && comments.every(comment => (
    comment && typeof comment === 'object' && !Array.isArray(comment)
    && typeof comment.id === 'string' && comment.id
    && typeof comment.comment === 'string'
  ))
}

export function loadRestoredComments(path, source) {
  if (!path) return []
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`could not read restored review comments: ${error.message}`)
  }
  const restoredSource = normalizeRestoredSource(payload)
  const expectedSource = sourceIdentity(source)
  if (!restoredSource || restoredSource.type !== expectedSource.type || restoredSource.value !== expectedSource.value) {
    throw new Error('restored review comments belong to a different source')
  }
  if (!validCommentList(payload.comments)) {
    throw new Error('restored review artifact must contain a comments list')
  }
  return payload.comments
}

export function injectHtml(html, endpoint, comments, overlayScript) {
  const serializedComments = JSON.stringify(comments)
    .replaceAll('<', '\\u003c')
    // File reviews append the overlay through a Latin-1 byte round trip, so
    // keep restored comment data ASCII-only while preserving Unicode values.
    .replace(/[^\x20-\x7e]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
  // Replacement callbacks keep `$&` and friends inside comment text literal
  // rather than letting them expand as replacement patterns.
  const script = overlayScript
    .replaceAll('__ENDPOINT__', () => JSON.stringify(endpoint))
    .replace('__INITIAL_COMMENTS__', () => serializedComments)
  const overlay = `<script>${script}</script>`
  let rendered = html
  const needsFavicon = !/<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i.test(rendered)
  if (needsFavicon) {
    const match = /<head(?:\s[^>]*)?>/i.exec(rendered)
    const favicon = '<link rel="icon" href="data:,">'
    if (match) rendered = `${rendered.slice(0, match.index + match[0].length)}${favicon}${rendered.slice(match.index + match[0].length)}`
    else rendered = `${favicon}${rendered}`
  }
  const bodyEnd = rendered.toLowerCase().lastIndexOf('</body>')
  return bodyEnd < 0 ? `${rendered}${overlay}` : `${rendered.slice(0, bodyEnd)}${overlay}${rendered.slice(bodyEnd)}`
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${randomBytes(5).toString('hex')}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

// HTTP and filesystem boundaries are deliberately narrow: request bodies are
// capped, incoming hosts must match the advertised listener, and symlinks cannot escape the
// reviewed file's directory.
function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    let total = 0
    const chunks = []
    request.on('data', chunk => {
      total += chunk.length
      if (total > 2_000_000) {
        reject(new Error('review payload is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function requestHostAllowed(request, allowedAuthority) {
  return String(request.headers.host || '').toLowerCase() === allowedAuthority.toLowerCase()
}

function sameOriginRequest(request) {
  const site = String(request.headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.origin
  if (!origin || Array.isArray(origin)) return !origin
  try {
    return new URL(origin).origin === new URL(`http://${request.headers.host}`).origin
  } catch {
    return false
  }
}

function topLevelDocumentNavigationRequest(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return false
  const mode = String(request.headers['sec-fetch-mode'] || '').toLowerCase()
  const destination = String(request.headers['sec-fetch-dest'] || '').toLowerCase()
  return (!mode || mode === 'navigate') && (!destination || destination === 'document')
}

function crossSiteReviewNavigationAllowed(request, requested, reviewPath, reviewSearch) {
  return topLevelDocumentNavigationRequest(request)
    && requested.pathname === reviewPath
    && requested.search === reviewSearch
}

function sendText(response, status, message) {
  const body = Buffer.from(message)
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
  })
  response.end(body)
}

function localFilePath(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const candidate = resolve(root, `.${decoded}`)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null
  const realRoot = realpathSync(root)
  if (!existsSync(candidate)) return candidate
  const realCandidate = realpathSync(candidate)
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) return null
  return realCandidate
}

function serveStaticAsset(request, response, root, log) {
  const pathname = new URL(request.url, 'http://review.local').pathname
  const path = localFilePath(root, pathname)
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    sendText(response, 404, 'Not found')
    return
  }
  const type = MIME_TYPES.get(extname(path).toLowerCase()) || 'application/octet-stream'
  const size = statSync(path).size
  response.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store' })
  const stream = createReadStream(path)
  stream.on('error', error => {
    log('error', 'Could not read static asset', { path, error: error.message })
    response.destroy(error)
  })
  stream.pipe(response)
}

function proxyHeaders(headers, source, forceIdentityEncoding = false) {
  const proxied = { ...headers, host: source.url.host }
  if (proxied.origin) proxied.origin = source.url.origin
  if (forceIdentityEncoding) proxied['accept-encoding'] = 'identity'
  return proxied
}

function trustedLanWarning(source) {
  if (source.type === 'file') {
    return `WARNING: --host has no auth; any LAN peer that reaches this review can access the entire allowed file tree under ${dirname(source.path)}.`
  }
  return `WARNING: --host has no auth; any LAN peer that reaches this review can proxy arbitrary routes, methods, bodies, and WebSockets to ${source.url.origin}.`
}

function proxyRequest(request, response, requested, source, inject, log, activeResources, upstreamTimeoutMs) {
  const upstreamPath = `${requested.pathname}${requested.search}`
  const upstream = httpRequest({
    hostname: upstreamHostname(source.url.hostname),
    port: source.url.port || 80,
    path: upstreamPath,
    method: request.method,
    headers: proxyHeaders(request.headers, source, true),
  }, upstreamResponse => {
    const type = String(upstreamResponse.headers['content-type'] || '')
    if (!type.includes('text/html') || request.method === 'HEAD') {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
      return
    }
    const chunks = []
    upstreamResponse.on('data', chunk => chunks.push(chunk))
    upstreamResponse.on('end', () => {
      const headers = { ...upstreamResponse.headers }
      delete headers['content-length']
      delete headers['content-security-policy']
      delete headers['content-security-policy-report-only']
      delete headers['transfer-encoding']
      delete headers['content-encoding']
      const html = Buffer.concat(chunks).toString('utf8')
      const body = Buffer.from(inject(html))
      headers['content-length'] = body.length
      headers['cache-control'] = 'no-store'
      response.writeHead(upstreamResponse.statusCode || 200, headers)
      response.end(body)
    })
  })
  activeResources.add(upstream)
  upstream.once('close', () => activeResources.delete(upstream))
  upstream.setTimeout(upstreamTimeoutMs, () => {
    upstream.destroy(new Error('the local page did not respond in time'))
  })
  upstream.on('error', error => {
    log('error', 'Could not reach served-page source', { source: source.url.href, error: error.message })
    if (!response.headersSent) sendText(response, 502, `Could not reach local page: ${error.message}`)
    else response.destroy(error)
  })
  request.pipe(upstream)
}

// Development servers use WebSockets for hot reload. Forward upgrades without
// interpreting frames so Next.js and similar local applications keep working.
function proxyUpgrade(request, socket, head, source, log, activeResources) {
  const upstream = netConnect(Number(source.url.port || 80), upstreamHostname(source.url.hostname), () => {
    const headers = proxyHeaders(request.headers, source)
    const lines = Object.entries(headers).flatMap(([name, value]) => Array.isArray(value)
      ? value.map(item => `${name}: ${item}`)
      : value === undefined ? [] : [`${name}: ${value}`])
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  activeResources.add(socket)
  activeResources.add(upstream)
  socket.once('close', () => activeResources.delete(socket))
  upstream.once('close', () => activeResources.delete(upstream))
  upstream.on('error', error => {
    log('error', 'WebSocket proxy failed', { path: request.url, error: error.message })
    socket.destroy()
  })
  socket.on('error', error => {
    log('error', 'Browser WebSocket closed with an error', { path: request.url, error: error.message })
    upstream.destroy()
  })
}

export async function createReviewServer({
  source,
  draftOutput,
  initialComments,
  overlayScript,
  log,
  host = null,
  port = 0,
  safetyTimeoutMs = REVIEW_SAFETY_TIMEOUT_MS,
  upstreamTimeoutMs = UPSTREAM_RESPONSE_TIMEOUT_MS,
}) {
  if (!validCommentList(initialComments)) throw new Error('initial comments must contain valid comment records')
  const trustedLanHost = host === null ? null : validateReviewHost(host)
  const token = randomBytes(24).toString('base64url')
  const endpoint = `/${token}`
  // Present the document at its original pathname so the browser resolves
  // relative assets, links, forms, and explicit <base> elements normally.
  const reviewPath = source.type === 'file' ? `/${encodeURIComponent(basename(source.path))}` : source.url.pathname
  const reviewSearch = source.type === 'url' ? source.url.search : ''
  let draftComments = initialComments
  let settled = false
  let settle
  let safetyTimer = null
  let closing = null
  const completion = new Promise(resolveCompletion => { settle = resolveCompletion })
  const sourceRecord = sourceIdentity(source)
  const serverConnections = new Set()
  const activeResources = new Set()
  let allowedAuthority = null

  const finish = (action, comments = []) => {
    if (settled) return
    settled = true
    settle({ action, comments })
  }

  // Draft writes are idempotent operations on stable comment IDs. Every page
  // opened by this invocation can add, update, or delete comments without
  // claiming browser ownership or replacing comments it has never seen.
  const saveDraft = payload => {
    if (!validCommentList(payload.comments)) throw new Error('comments must be a list of valid comment records')
    const deletedIds = payload.deleted_ids ?? []
    if (!Array.isArray(deletedIds) || deletedIds.some(id => typeof id !== 'string' || !id)) {
      throw new Error('deleted_ids must be a list of nonempty strings')
    }
    const commentById = new Map(draftComments.map(comment => [comment.id, comment]))
    for (const id of deletedIds) commentById.delete(id)
    for (const comment of payload.comments) commentById.set(comment.id, comment)
    draftComments = [...commentById.values()]
    if (draftOutput) {
      writeJsonAtomic(draftOutput, {
        version: 2,
        source: sourceRecord,
        saved_at: new Date().toISOString(),
        comments: draftComments,
      })
      log('info', 'Saved recoverable draft', { comments: draftComments.length })
    }
  }

  const handleRequest = async (request, response) => {
    const requested = new URL(request.url, 'http://review.local')
    if (!requestHostAllowed(request, allowedAuthority)) {
      sendText(response, 403, 'Review host not allowed')
      return
    }
    if (!sameOriginRequest(request) && !crossSiteReviewNavigationAllowed(request, requested, reviewPath, reviewSearch)) {
      sendText(response, 403, 'Same-origin access only')
      return
    }
    const action = requested.pathname.slice(endpoint.length + 1)
    if (request.method === 'POST' && requested.pathname.startsWith(`${endpoint}/`) && ['draft', 'submit', 'cancel'].includes(action)) {
      let payload = {}
      try {
        const content = await readRequestBody(request)
        payload = content ? JSON.parse(content) : {}
        if (action === 'draft') {
          saveDraft(payload)
        } else if (action === 'submit') {
          finish(action, draftComments)
          log('info', 'Review submitted', { comments: draftComments.length })
        } else if (!settled) {
          finish(action)
          log('info', 'Review cancelled')
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      } catch (error) {
        log('error', 'Rejected review request', { action, error: error.message })
        sendText(response, error.statusCode || 400, error.message)
      }
      return
    }

    const inject = html => injectHtml(html, endpoint, draftComments, overlayScript)
    if (source.type === 'file') {
      if (['GET', 'HEAD'].includes(request.method) && requested.pathname === reviewPath) {
        try {
          // Latin-1 provides a one-byte round trip, preserving the source
          // file's bytes while appending the ASCII overlay script.
          const body = Buffer.from(inject(readFileSync(source.path, 'latin1')), 'latin1')
          response.writeHead(200, { 'content-type': 'text/html', 'content-length': body.length, 'cache-control': 'no-store' })
          if (request.method === 'HEAD') response.end()
          else response.end(body)
        } catch (error) {
          log('error', 'Could not serve reviewed HTML file', { path: source.path, error: error.message })
          sendText(response, 500, error.message)
        }
        return
      }
      if (requested.pathname.startsWith(`${endpoint}/`)) {
        sendText(response, 404, 'Not found')
        return
      }
      serveStaticAsset(request, response, dirname(source.path), log)
      return
    }
    proxyRequest(request, response, requested, source, inject, log, activeResources, upstreamTimeoutMs)
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      const requestError = error instanceof Error ? error : new Error(String(error))
      log('error', 'Review request failed', { url: request.url, error: requestError.message })
      if (!response.headersSent && !response.writableEnded) sendText(response, 500, 'Review request failed')
      else if (!response.destroyed) response.destroy(requestError)
    })
  })

  server.on('connection', socket => {
    serverConnections.add(socket)
    socket.once('close', () => serverConnections.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    if (!requestHostAllowed(request, allowedAuthority) || !sameOriginRequest(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (source.type === 'url') proxyUpgrade(request, socket, head, source, log, activeResources)
    else socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  })
  server.on('clientError', (error, socket) => {
    log('error', 'Review server rejected a client connection', { error: error.message })
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    const hostname = trustedLanHost || (source.type === 'url' ? upstreamHostname(source.url.hostname) : '127.0.0.1')
    const onError = error => rejectListen(new Error(`could not bind review server to ${hostname}:${port || 'an available port'}: ${error.message}`, { cause: error }))
    server.once('error', onError)
    server.listen(port, hostname, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  const address = server.address()
  const reviewHostname = trustedLanHost || (source.type === 'url' ? source.url.hostname : '127.0.0.1')
  allowedAuthority = httpAuthority(reviewHostname, address.port)
  const reviewUrl = `http://${allowedAuthority}${reviewPath}${reviewSearch}`
  log('info', 'Review server ready', { review_url: reviewUrl, bind_host: reviewHostname, port: address.port })
  safetyTimer = setTimeout(() => {
    if (settled) return
    log('info', 'Review reached the safety timeout; stopping worker', { timeout_ms: safetyTimeoutMs })
    finish('timeout')
  }, safetyTimeoutMs)
  safetyTimer.unref()

  return {
    reviewUrl,
    completion,
    async close() {
      if (closing) return closing
      closing = (async () => {
        if (safetyTimer) clearTimeout(safetyTimer)
        const closed = new Promise(resolveClose => server.close(() => resolveClose()))
        for (const resource of activeResources) resource.destroy()
        const forceCloseTimer = setTimeout(() => {
          for (const socket of serverConnections) socket.destroy()
        }, FORCE_CLOSE_GRACE_MS)
        forceCloseTimer.unref()
        await closed
        clearTimeout(forceCloseTimer)
        log('info', 'Review server stopped')
      })()
      return closing
    },
  }
}

// Async mode uses a short-lived ready file only as a launch handshake; durable
// state lives in the result, draft, and log companions.
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIRECTORY = dirname(SCRIPT_PATH)
const GEOMETRY_SCRIPT = readFileSync(resolve(SCRIPT_DIRECTORY, 'review_geometry.cjs'), 'utf8')
// Keep helpers private to this single injected payload while allowing the
// overlay source to use its geometry binding directly.
const OVERLAY_SCRIPT = `(() => {\n${GEOMETRY_SCRIPT}\n${readFileSync(resolve(SCRIPT_DIRECTORY, 'review_overlay.js'), 'utf8')}\n})();`

function usage() {
  console.log(`Usage: node html_review.mjs <HTML-file-or-loopback-URL> [options]

Collect element- or text-linked comments in the default browser.

Options:
  --output PATH             Write submitted feedback JSON to PATH
  --async                   Return after opening; requires --output
  --restore-comments PATH   Restore comments from submitted or draft JSON
  --no-open                 Start the server without opening a browser
  --port PORT               Bind the review server to a specific port
  --host IPV4               Bind and advertise one active non-loopback local IPv4 address
  --help                    Show this help

The source may be an existing .html/.htm file or an http:// URL on localhost,
127.0.0.1, or ::1. Served-page sources must already be running.`)
}

function parseArgs(argv) {
  const args = { asynchronous: false, worker: false, no_open: false, port: 0, host: null }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      usage()
      return null
    }
    if (argument === '--async') args.asynchronous = true
    else if (argument === '--no-open') args.no_open = true
    else if (argument === '--worker') args.worker = true
    else if (argument === '--port') {
      const value = argv[++index]
      if (!value) throw new Error('--port requires a value')
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error('--port must be an integer from 1 to 65535')
      }
      args.port = Number(value)
    } else if (argument === '--host') {
      const value = argv[++index]
      if (!value) throw new Error('--host requires a value')
      args.host = validateReviewHost(value)
    } else if (argument === '--output' || argument === '--restore-comments' || argument === '--ready-file') {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      args[argument.slice(2).replaceAll('-', '_')] = resolve(value)
    } else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    else positionals.push(argument)
  }
  if (positionals.length !== 1) throw new Error('exactly one HTML file or loopback URL is required')
  args.source = parseSource(positionals[0])
  if (args.asynchronous && !args.output) throw new Error('--async requires --output')
  if (args.output && existsSync(args.output)) throw new Error('--output must not already exist')
  if (args.restore_comments && !existsSync(args.restore_comments)) throw new Error('--restore-comments must be an existing review JSON file')
  if (args.asynchronous && args.output && !args.worker) {
    const companions = [draftPath(args.output), logPath(args.output)].filter(existsSync)
    if (companions.length) throw new Error(`review companion paths must not already exist: ${companions.join(', ')}`)
  }
  return args
}

function draftPath(output) {
  return output.replace(/\.json$/i, '') + '.draft.json'
}

function logPath(output) {
  return output.replace(/\.json$/i, '') + '.log'
}

function createLogger(path) {
  return (level, message, details = undefined) => {
    const suffix = details ? ` ${JSON.stringify(details)}` : ''
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`
    if (path) appendFileSync(path, line)
    if (level === 'error') process.stderr.write(line)
  }
}

function emitTrustedLanWarning(log, args, reviewUrl, { stdout = true, fileLog = true } = {}) {
  if (!args.host) return
  const warning = trustedLanWarning(args.source)
  if (fileLog) log('warn', warning, { review_url: reviewUrl, host: args.host })
  if (stdout) console.log(warning)
}

function browserCommand(url) {
  if (process.platform === 'darwin') return { command: 'open', args: [url] }
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

function openBrowser(url, log) {
  return new Promise((resolveOpen, rejectOpen) => {
    const invocation = browserCommand(url)
    const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore' })
    child.once('error', rejectOpen)
    child.once('spawn', () => {
      log('info', 'Opened default browser', { command: invocation.command, review_url: url })
      child.unref()
      resolveOpen()
    })
  })
}

function initializeLog(path, args) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  if (!args.worker) {
    const descriptor = openSync(path, 'wx')
    closeSync(descriptor)
  }
  const log = createLogger(path)
  log('info', args.worker ? 'Review worker started' : 'Review launch started', {
    source: sourceIdentity(args.source),
    result: args.output || null,
    draft: args.output ? draftPath(args.output) : null,
    restored_comments: args.restore_comments || null,
    no_open: args.no_open,
    port: args.port || null,
    host: args.host,
    pid: process.pid,
  })
}

function recordStartupFailure(argv, error) {
  const outputIndex = argv.indexOf('--output')
  const outputValue = outputIndex >= 0 ? argv[outputIndex + 1] : null
  if (!outputValue) return
  const output = resolve(outputValue)
  const logOutput = logPath(output)
  const worker = argv.includes('--worker')
  try {
    mkdirSync(dirname(logOutput), { recursive: true })
    if (!existsSync(logOutput)) {
      const descriptor = openSync(logOutput, 'wx')
      closeSync(descriptor)
    } else if (!worker) {
      return
    }
    createLogger(logOutput)('error', 'Review could not start', { error: error.message, stack: error.stack })
  } catch {
    // The original validation error remains authoritative when logging itself fails.
  }
}

async function runReview(args) {
  const output = args.output || null
  const draftOutput = output ? draftPath(output) : null
  const logOutput = output ? logPath(output) : null
  initializeLog(logOutput, args)
  const log = createLogger(logOutput)
  let server
  try {
    const initialComments = loadRestoredComments(args.restore_comments, args.source)
    if (initialComments.length) log('info', 'Restored comments', { path: args.restore_comments, comments: initialComments.length })
    server = await createReviewServer({
      source: args.source,
      draftOutput,
      initialComments,
      overlayScript: OVERLAY_SCRIPT,
      log,
      host: args.host,
      port: args.port,
    })
    emitTrustedLanWarning(log, args, server.reviewUrl, { stdout: !args.worker })
    if (args.no_open) {
      log('info', 'Skipped default browser launch', { review_url: server.reviewUrl })
      if (!args.worker) process.stdout.write(`Review URL: ${server.reviewUrl}\n`)
    }
    else await openBrowser(server.reviewUrl, log)
    if (args.ready_file) writeFileSync(args.ready_file, `${server.reviewUrl}\n`)
    const result = await server.completion
    if (result.action !== 'submit') {
      log('info', 'Review completed without submission', { action: result.action })
      process.stderr.write('Review cancelled.\n')
      return 2
    }
    const payload = {
      version: 2,
      source: sourceIdentity(args.source),
      submitted_at: new Date().toISOString(),
      comments: result.comments,
    }
    if (output) writeJsonAtomic(output, payload)
    log('info', 'Wrote submitted feedback', { output, comments: result.comments.length })
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  } catch (error) {
    log('error', 'Review failed', { error: error.message, stack: error.stack })
    process.stderr.write(`${error.message}\n`)
    return 1
  } finally {
    if (server) await server.close()
  }
}

async function launchAsync(args) {
  const output = args.output
  const draftOutput = draftPath(output)
  const logOutput = logPath(output)
  const readyFile = resolve(dirname(output), `.html-review-${randomBytes(5).toString('hex')}.ready`)
  initializeLog(logOutput, args)
  const log = createLogger(logOutput)
  const childArgs = [SCRIPT_PATH, args.source.type === 'file' ? args.source.path : args.source.url.href, '--output', output, '--worker', '--ready-file', readyFile]
  if (args.restore_comments) childArgs.push('--restore-comments', args.restore_comments)
  if (args.no_open) childArgs.push('--no-open')
  if (args.port) childArgs.push('--port', String(args.port))
  if (args.host) childArgs.push('--host', args.host)
  const descriptor = openSync(logOutput, 'a')
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', descriptor, descriptor],
  })
  closeSync(descriptor)
  child.unref()
  log('info', 'Detached review worker', { worker_pid: child.pid })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      const readyUrl = readFileSync(readyFile, 'utf8').trim()
      rmSync(readyFile)
      emitTrustedLanWarning(log, args, readyUrl, { fileLog: false })
      log('info', args.no_open ? 'Review server started successfully' : 'Review opened successfully', { worker_pid: child.pid })
      if (args.no_open) console.log(`Review URL: ${readyUrl}`)
      console.log(`${args.no_open ? 'Review server started' : 'Review opened'}. Submitted feedback: ${output}`)
      console.log(`Recoverable draft: ${draftOutput}`)
      console.log(`Worker log: ${logOutput}`)
      if (args.restore_comments) console.log(`Restored comments from: ${args.restore_comments}`)
      return 0
    }
    if (child.exitCode !== null) {
      log('error', 'Review worker exited before browser readiness', { exit_code: child.exitCode })
      console.error(`Could not start the asynchronous review. Inspect ${logOutput}`)
      return 1
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  try {
    process.kill(child.pid, 'SIGTERM')
  } catch (error) {
    const level = error.code === 'ESRCH' ? 'info' : 'error'
    log(level, 'Could not stop timed-out review worker', { worker_pid: child.pid, error: error.message })
  }
  log('error', 'Timed out waiting for browser readiness', { worker_pid: child.pid })
  console.error(`Timed out while opening the asynchronous review. Inspect ${logOutput}`)
  return 1
}

export { draftPath, logPath, parseArgs }

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args) return 0
    return args.asynchronous && !args.worker ? launchAsync(args) : runReview(args)
  } catch (error) {
    recordStartupFailure(process.argv.slice(2), error)
    console.error(error.message)
    return 1
  }
}

if (resolve(process.argv[1] || '') === resolve(SCRIPT_PATH)) process.exitCode = await main()
