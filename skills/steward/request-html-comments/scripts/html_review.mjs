#!/usr/bin/env node

// Zero-dependency runtime for the portable skill. Keeping the local server,
// loopback proxy, and CLI lifecycle together makes the skill installable as a
// five-file directory without a package manager or build step.

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
import { connect as netConnect } from 'node:net'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const REVIEW_SAFETY_TIMEOUT_MS = 60 * 60 * 1000
const TAB_CLOSE_GRACE_MS = 60 * 1000
const FORCE_CLOSE_GRACE_MS = 250
export const DRAFT_IDENTIFIER_MAX_LENGTH = 128
export const EARLY_HANDOFF_CANDIDATE_LIMIT = 4
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

// Source identity is persisted with drafts and submissions so comments cannot
// be restored onto a different file or application route by accident.
function loopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(hostname)
}

function upstreamHostname(hostname) {
  return hostname === '[::1]' ? '::1' : hostname
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
  if (!Array.isArray(payload.comments) || payload.comments.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('restored review artifact must contain a comments list')
  }
  return payload.comments
}

export function createDraftSession(storage, key, createId, initialComments = [], reportError = () => {}, maximumIdentifierLength = DRAFT_IDENTIFIER_MAX_LENGTH) {
  const validIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= maximumIdentifierLength
  const validComments = comments => Array.isArray(comments) && comments.every(comment => (
    comment && typeof comment === 'object' && !Array.isArray(comment)
    && typeof comment.id === 'string' && comment.id
    && typeof comment.comment === 'string'
  ))
  const validState = value => (
    value && typeof value === 'object' && !Array.isArray(value)
    && validIdentifier(value.clientId)
    && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision < Number.MAX_SAFE_INTEGER
    && validComments(value.comments)
    && (value.handoffCredential === null || validIdentifier(value.handoffCredential))
  )
  let state = null
  if (!storage) {
    reportError('Browser session storage is unavailable; draft reload recovery is disabled.')
  } else {
    try {
      const stored = storage.getItem(key)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (validState(parsed)) state = parsed
        else reportError('Stored review draft state is invalid; reload recovery was reset.')
      }
    } catch (error) {
      reportError(`Could not read browser session storage; draft reload recovery is disabled: ${error.message}`)
    }
  }
  if (!validComments(initialComments)) throw new Error('initial comments must contain valid comment records')
  if (!state) state = { clientId: createId(), revision: 0, comments: initialComments, handoffCredential: null }
  if (!validIdentifier(state.clientId)) throw new Error(`draft client ID must be between 1 and ${maximumIdentifierLength} characters`)
  const instanceId = createId()
  if (!validIdentifier(instanceId)) throw new Error(`draft instance ID must be between 1 and ${maximumIdentifierLength} characters`)

  const persist = () => {
    if (!storage) return
    try {
      storage.setItem(key, JSON.stringify(state))
    } catch (error) {
      reportError(`Could not write browser session storage; draft reload recovery is disabled: ${error.message}`)
    }
  }
  persist()

  return {
    clientId: state.clientId,
    instanceId,
    get comments() { return state.comments },
    get handoffCredential() { return state.handoffCredential },
    get revision() { return state.revision },
    nextRevision(comments) {
      if (!validComments(comments)) throw new Error('draft comments must contain valid comment records')
      if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('draft revision cannot be incremented safely')
      state.revision += 1
      state.comments = comments
      persist()
      return state.revision
    },
    prepareHandoff(comments) {
      const reconnectCredential = state.handoffCredential
      const revision = this.nextRevision(comments)
      const handoffCredential = createId()
      if (!validIdentifier(handoffCredential)) throw new Error(`draft handoff credential must be between 1 and ${maximumIdentifierLength} characters`)
      state.handoffCredential = handoffCredential
      persist()
      return { handoffCredential, reconnectCredential, revision }
    },
    completeHandoff(credential) {
      if (!credential || state.handoffCredential !== credential) return
      state.handoffCredential = null
      persist()
    },
  }
}

export function injectHtml(html, endpoint, comments, overlayScript, addBase = false) {
  const serializedComments = JSON.stringify(comments).replaceAll('<', '\\u003c')
  const script = overlayScript
    .replace('__CREATE_DRAFT_SESSION__', `(${createDraftSession.toString()})`)
    .replace('__DRAFT_IDENTIFIER_MAX_LENGTH__', String(DRAFT_IDENTIFIER_MAX_LENGTH))
    .replaceAll('__ENDPOINT__', JSON.stringify(endpoint))
    .replace('__INITIAL_COMMENTS__', serializedComments)
  const overlay = `<script>${script}</script>`
  let rendered = html
  const needsFavicon = !/<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i.test(rendered)
  const headAdditions = `${addBase ? '<base href="/">' : ''}${needsFavicon ? '<link rel="icon" href="data:,">' : ''}`
  if (headAdditions) {
    const match = /<head(?:\s[^>]*)?>/i.exec(rendered)
    if (match) rendered = `${rendered.slice(0, match.index + match[0].length)}${headAdditions}${rendered.slice(match.index + match[0].length)}`
    else rendered = `${headAdditions}${rendered}`
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
// capped, incoming hosts must be loopback, and symlinks cannot escape the
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

function requestHostIsLoopback(request) {
  const host = String(request.headers.host || '')
  return host.startsWith('127.0.0.1:') || host === '127.0.0.1' || host.startsWith('localhost:') || host === 'localhost'
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
  if (!existsSync(candidate)) return candidate
  const realRoot = realpathSync(root)
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

function proxyRequest(request, response, requested, source, initialPath, inject, log, activeResources) {
  const upstreamPath = requested.pathname === initialPath
    ? `${source.url.pathname}${source.url.search}`
    : `${requested.pathname}${requested.search}`
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
  safetyTimeoutMs = REVIEW_SAFETY_TIMEOUT_MS,
  tabCloseGraceMs = TAB_CLOSE_GRACE_MS,
  handoffOrderingGraceMs = tabCloseGraceMs,
}) {
  const token = randomBytes(24).toString('base64url')
  const endpoint = `/${token}`
  const initialPath = `${endpoint}/review`
  let draftClient = null
  let draftInstance = null
  let pendingHandoffCredential = null
  let lastDraftRevision = -1
  let settled = false
  let settle
  let safetyTimer = null
  let tabCloseTimer = null
  const earlyHandoffs = new Map()
  let closing = null
  const completion = new Promise(resolveCompletion => { settle = resolveCompletion })
  const sourceRecord = sourceIdentity(source)
  const serverConnections = new Set()
  const activeResources = new Set()

  const finish = (action, comments = []) => {
    if (settled) return
    settled = true
    settle({ action, comments })
  }

  const cancelTabClose = () => {
    if (!tabCloseTimer) return
    clearTimeout(tabCloseTimer)
    tabCloseTimer = null
    log('info', 'Review tab reconnected before shutdown')
  }

  const clearEarlyHandoff = credential => {
    const candidate = earlyHandoffs.get(credential)
    if (!candidate) return null
    clearTimeout(candidate.timer)
    earlyHandoffs.delete(credential)
    return candidate
  }

  const validateIdentifier = (value, name, required = true) => {
    if (!required && (value === null || value === undefined)) return
    if (typeof value !== 'string' || !value) throw new Error(`${name} must be a nonempty string`)
    if (value.length > DRAFT_IDENTIFIER_MAX_LENGTH) {
      throw new Error(`${name} must not exceed ${DRAFT_IDENTIFIER_MAX_LENGTH} characters`)
    }
  }

  const queueEarlyHandoff = payload => {
    const credential = payload.handoff_credential
    if (typeof credential !== 'string' || !credential) return false
    if (earlyHandoffs.has(credential)) return earlyHandoffs.get(credential).instanceId === payload.instance_id
    if (earlyHandoffs.size >= EARLY_HANDOFF_CANDIDATE_LIMIT) {
      const error = new Error(`too many pending reload handoffs; limit is ${EARLY_HANDOFF_CANDIDATE_LIMIT}`)
      error.statusCode = 409
      throw error
    }
    const timer = setTimeout(() => earlyHandoffs.delete(credential), handoffOrderingGraceMs)
    timer.unref()
    earlyHandoffs.set(credential, { clientId: payload.client_id, instanceId: payload.instance_id, timer })
    return true
  }

  const scheduleTabClose = credential => {
    if (tabCloseTimer || settled) return
    pendingHandoffCredential = credential
    const earlyHandoff = clearEarlyHandoff(credential)
    if (earlyHandoff?.clientId === draftClient) {
      draftInstance = earlyHandoff.instanceId
      pendingHandoffCredential = null
      log('info', 'Review tab reconnected after an ordered handoff')
      return
    }
    tabCloseTimer = setTimeout(() => {
      tabCloseTimer = null
      pendingHandoffCredential = null
      if (settled) return
      log('info', 'Review tab remained closed; stopping worker')
      finish('abandon')
    }, tabCloseGraceMs)
    tabCloseTimer.unref()
    log('info', 'Review tab closed; waiting briefly for reconnection', { grace_ms: tabCloseGraceMs })
  }

  const claimDraftSession = (payload, allowEarlyHandoff = false) => {
    validateIdentifier(payload.client_id, 'client_id')
    validateIdentifier(payload.instance_id, 'instance_id')
    validateIdentifier(payload.handoff_credential, 'handoff_credential', false)
    if (!draftClient) {
      draftClient = payload.client_id
      draftInstance = payload.instance_id
      return
    }
    if (payload.client_id === draftClient && payload.instance_id !== draftInstance && tabCloseTimer
      && typeof payload.handoff_credential === 'string' && payload.handoff_credential
      && payload.handoff_credential === pendingHandoffCredential) {
      draftInstance = payload.instance_id
      pendingHandoffCredential = null
      clearEarlyHandoff(payload.handoff_credential)
      cancelTabClose()
      return 'owned'
    }
    if (payload.client_id === draftClient && payload.instance_id !== draftInstance && !tabCloseTimer
      && allowEarlyHandoff && queueEarlyHandoff(payload)) {
      return 'pending'
    }
    if (payload.client_id !== draftClient || payload.instance_id !== draftInstance) {
      const error = new Error('another browser tab owns this review draft')
      error.statusCode = 409
      throw error
    }
    return 'owned'
  }

  const saveDraft = payload => {
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error('revision must be a nonnegative safe integer')
    if (!Array.isArray(payload.comments)) throw new Error('comments must be a list')
    claimDraftSession(payload)
    if (payload.revision <= lastDraftRevision) {
      const error = new Error('draft revision is stale')
      error.statusCode = 409
      throw error
    }
    if (!draftOutput) return
    writeJsonAtomic(draftOutput, {
      version: 2,
      source: sourceRecord,
      saved_at: new Date().toISOString(),
      revision: payload.revision,
      comments: payload.comments,
    })
    lastDraftRevision = payload.revision
    log('info', 'Saved recoverable draft', { revision: payload.revision, comments: payload.comments.length })
  }

  const server = createServer(async (request, response) => {
    if (!requestHostIsLoopback(request)) {
      sendText(response, 403, 'Loopback access only')
      return
    }
    const requested = new URL(request.url, 'http://review.local')
    const action = requested.pathname.slice(endpoint.length + 1)
    if (request.method === 'POST' && requested.pathname.startsWith(`${endpoint}/`) && ['draft', 'heartbeat', 'abandon', 'submit', 'cancel'].includes(action)) {
      let payload = {}
      let responseStatus = 200
      let responseBody = '{"ok":true}'
      try {
        const content = await readRequestBody(request)
        payload = content ? JSON.parse(content) : {}
        if (action === 'draft' || action === 'abandon') {
          if (action === 'abandon') validateIdentifier(payload.next_handoff_credential, 'next_handoff_credential')
          saveDraft(payload)
          if (action === 'abandon') scheduleTabClose(payload.next_handoff_credential)
        } else if (action === 'heartbeat') {
          if (claimDraftSession(payload, true) === 'pending') {
            responseStatus = 202
            responseBody = '{"ok":false,"pending":true}'
          }
        } else if (action === 'submit') {
          if (!Array.isArray(payload.comments)) throw new Error('comments must be a list')
          claimDraftSession(payload)
          finish(action, payload.comments)
          log('info', 'Review submitted', { comments: payload.comments.length })
        } else {
          claimDraftSession(payload)
          if (settled) throw new Error('review is already complete')
          finish(action)
          log('info', 'Review cancelled')
        }
        response.writeHead(responseStatus, { 'content-type': 'application/json' })
        response.end(responseBody)
      } catch (error) {
        if (error.statusCode === 409) {
          log('error', error.message === 'draft revision is stale' ? 'Rejected stale draft revision' : 'Rejected conflicting draft writer', {
            client_id: payload?.client_id,
            revision: payload?.revision,
            current_revision: lastDraftRevision,
          })
        } else {
          log('error', 'Rejected review request', { action, error: error.message })
        }
        sendText(response, error.statusCode || 400, error.message)
      }
      return
    }

    const inject = html => injectHtml(html, endpoint, initialComments, overlayScript, source.type === 'file')
    if (source.type === 'file') {
      if (request.method === 'GET' && requested.pathname === initialPath) {
        try {
          // Latin-1 provides a one-byte round trip, preserving the source
          // file's bytes while appending the ASCII overlay script.
          const body = Buffer.from(inject(readFileSync(source.path, 'latin1')), 'latin1')
          response.writeHead(200, { 'content-type': 'text/html', 'content-length': body.length, 'cache-control': 'no-store' })
          response.end(body)
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
    proxyRequest(request, response, requested, source, initialPath, inject, log, activeResources)
  })

  server.on('connection', socket => {
    serverConnections.add(socket)
    socket.once('close', () => serverConnections.delete(socket))
  })
  if (source.type === 'url') server.on('upgrade', (request, socket, head) => proxyUpgrade(request, socket, head, source, log, activeResources))
  server.on('clientError', (error, socket) => {
    log('error', 'Review server rejected a client connection', { error: error.message })
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const reviewUrl = `http://127.0.0.1:${address.port}${initialPath}`
  log('info', 'Review server ready', { review_url: reviewUrl })
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
        if (tabCloseTimer) clearTimeout(tabCloseTimer)
        for (const candidate of earlyHandoffs.values()) clearTimeout(candidate.timer)
        earlyHandoffs.clear()
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
const OVERLAY_SCRIPT = readFileSync(resolve(SCRIPT_DIRECTORY, 'review_overlay.js'), 'utf8')

function usage() {
  console.log(`Usage: node html_review.mjs <HTML-file-or-loopback-URL> [options]

Collect element- or text-linked comments in the default browser.

Options:
  --output PATH             Write submitted feedback JSON to PATH
  --async                   Return after opening; requires --output
  --restore-comments PATH   Restore comments from submitted or draft JSON
  --help                    Show this help

The source may be an existing .html/.htm file or an http:// URL on localhost,
127.0.0.1, or ::1. Served-page sources must already be running.`)
}

function parseArgs(argv) {
  const args = { asynchronous: false, worker: false }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      usage()
      return null
    }
    if (argument === '--async') args.asynchronous = true
    else if (argument === '--worker') args.worker = true
    else if (argument === '--output' || argument === '--restore-comments' || argument === '--ready-file') {
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
    })
    await openBrowser(server.reviewUrl, log)
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
      rmSync(readyFile)
      log('info', 'Review opened successfully', { worker_pid: child.pid })
      console.log(`Review opened. Submitted feedback: ${output}`)
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
