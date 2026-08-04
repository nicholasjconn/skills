import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createReviewServer,
  injectHtml,
  loadRestoredComments,
  parseSource,
  sourceIdentity,
  logPath,
} from '../scripts/html_review.mjs'

const OVERLAY_SCRIPT = readFileSync(fileURLToPath(new URL('../scripts/review_overlay.js', import.meta.url)), 'utf8')

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'html-review-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

function websocketHandshake(port, path, origin) {
  return new Promise((resolveHandshake, rejectHandshake) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      response += chunk
      if (response.includes('\r\n\r\n')) {
        socket.end()
        resolveHandshake(response)
      }
    })
    socket.on('error', rejectHandshake)
  })
}

function openWebsocket(port, path, origin) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    socket.once('data', () => resolveSocket(socket))
    socket.once('error', rejectSocket)
  })
}

test('source parsing accepts HTML files and loopback HTTP URLs only', t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html></html>')

  assert.deepEqual(sourceIdentity(parseSource(html)), { type: 'file', value: html })
  assert.deepEqual(sourceIdentity(parseSource('http://localhost:3000/path')), {
    type: 'url',
    value: 'http://localhost:3000/path',
  })
  assert.throws(() => parseSource('https://localhost:3000/path'), /http:\/\/ loopback URL/)
  assert.throws(() => parseSource('http://example.com/path'), /http:\/\/ loopback URL/)
  assert.throws(() => parseSource(join(directory, 'missing.html')), /existing .html/)
})

test('invalid startup input leaves an actionable worker log', t => {
  const directory = temporaryDirectory(t)
  const output = join(directory, 'feedback.json')
  const script = fileURLToPath(new URL('../scripts/html_review.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'http://example.com/page', '--async', '--output', output], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /loopback URL/)
  // Async mode detaches, so the log file is the only diagnostic the caller gets.
  assert.match(readFileSync(logPath(output), 'utf8'), /loopback URL/)
})

test('restore accepts legacy and versioned artifacts but rejects another source', t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  const other = join(directory, 'other.html')
  const legacy = join(directory, 'legacy.json')
  const versioned = join(directory, 'versioned.json')
  writeFileSync(html, '<html></html>')
  writeFileSync(other, '<html></html>')
  const comments = [{ id: 'one', comment: 'Keep this' }]
  writeFileSync(legacy, JSON.stringify({ version: 1, source: html, comments }))
  const servedSource = parseSource('http://localhost:3100/review-me')
  writeFileSync(versioned, JSON.stringify({ version: 2, source: sourceIdentity(servedSource), comments }))

  assert.deepEqual(loadRestoredComments(legacy, parseSource(html)), comments)
  assert.deepEqual(loadRestoredComments(versioned, servedSource), comments)
  const malformed = join(directory, 'malformed.json')
  writeFileSync(malformed, JSON.stringify({ version: 2, source: sourceIdentity(parseSource(html)), comments: [{ id: 'broken' }] }))
  assert.throws(() => loadRestoredComments(malformed, parseSource(html)), /comments list/)
  // Restoring onto the wrong page would silently attach comments to it.
  assert.throws(() => loadRestoredComments(legacy, parseSource(other)), /different source/)
  assert.throws(
    () => loadRestoredComments(versioned, parseSource('http://localhost:3100/another-page')),
    /different source/,
  )
})

test('overlay injection keeps comment text inert and yields a parseable script', () => {
  const rendered = injectHtml(
    '<html><head></head><body>Review me</body></html>',
    '/token',
    [{ id: 'one', comment: 'Keep </script> and __ENDPOINT__ __INITIAL_COMMENTS__ $& $` safe' }],
    OVERLAY_SCRIPT,
    true,
  )

  // Without <base>, relative asset URLs would resolve against the token path.
  assert.match(rendered, /<base href="\/">/)
  assert.match(rendered, /Keep \\u003c\/script>/)
  assert.match(rendered, /const endpoint = "\/token"/)
  // Comment text is substituted last, and never as a replacement pattern,
  // so placeholders and `$` sequences inside it stay literal.
  assert.match(rendered, /and __ENDPOINT__ __INITIAL_COMMENTS__ \$& \$` safe/)
  const scriptStart = rendered.lastIndexOf('<script>') + '<script>'.length
  const scriptEnd = rendered.indexOf('</script>', scriptStart)
  assert.ok(scriptEnd < rendered.toLowerCase().lastIndexOf('</body>'))
  assert.doesNotThrow(() => new Function(rendered.slice(scriptStart, scriptEnd)))
})

test('file review serves local assets, persists drafts, and submits versioned feedback', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  const css = join(directory, 'page.css')
  const outsideDirectory = temporaryDirectory(t)
  const outside = join(outsideDirectory, 'private.txt')
  const escapedLink = join(directory, 'escaped.txt')
  const draft = join(directory, 'feedback.draft.json')
  writeFileSync(html, '<html><head><link rel="stylesheet" href="page.css"></head><body>Review me</body></html>')
  writeFileSync(css, 'body { color: red; }')
  writeFileSync(outside, 'must remain private')
  if (process.platform !== 'win32') symlinkSync(outside, escapedLink)
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: draft,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: () => {},
  })
  t.after(() => review.close())

  const pageResponse = await fetch(review.reviewUrl)
  assert.equal(pageResponse.status, 200)
  assert.match(await pageResponse.text(), /const endpoint="\/[^"]+"/)
  const assetResponse = await fetch(new URL('/page.css', review.reviewUrl))
  assert.equal(assetResponse.status, 200)
  assert.equal(await assetResponse.text(), 'body { color: red; }')
  if (process.platform !== 'win32') {
    const escapedResponse = await fetch(new URL('/escaped.txt', review.reviewUrl))
    assert.equal(escapedResponse.status, 404)
  }

  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const comments = [{ id: 'one', target_type: 'text', comment: 'Clarify this' }]
  const draftResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'primary-tab', revision: 3, comments }),
  })
  assert.equal(draftResponse.status, 200)
  const persisted = JSON.parse(readFileSync(draft, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.deepEqual(persisted.source, { type: 'file', value: html })
  assert.deepEqual(persisted.comments, comments)

  // A retried or reordered write must not roll the draft back.
  const staleResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'primary-tab', revision: 2, comments: [] }),
  })
  assert.equal(staleResponse.status, 409)
  assert.match(await staleResponse.text(), /draft revision is stale/)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, comments)

  const submitResponse = await fetch(new URL(`${endpoint}/submit`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'primary-tab', comments }),
  })
  assert.equal(submitResponse.status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments })
})

test('a reloading tab resumes its draft while a second tab cannot overwrite it', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  const draft = join(directory, 'feedback.draft.json')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: draft,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: () => {},
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const post = (action, payload) => fetch(new URL(`${endpoint}/${action}`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const comments = [{ id: 'one', comment: 'Keep this through the reload' }]

  assert.equal((await post('draft', { client_id: 'review-tab', revision: 1, comments })).status, 200)

  // The reloading tab reads its own work back from the page the server serves,
  // so the browser never has to persist comments itself.
  assert.match(await (await fetch(review.reviewUrl)).text(), /Keep this through the reload/)

  // Session storage carries the client ID and revision counter across the
  // reload, so the same tab keeps writing instead of looking like a rival.
  const resumed = [...comments, { id: 'two', comment: 'Added after the reload' }]
  assert.equal((await post('draft', { client_id: 'review-tab', revision: 2, comments: resumed })).status, 200)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, resumed)

  // A second tab starts fresh and cannot overwrite the first tab's work.
  const second = await post('draft', { client_id: 'second-tab', revision: 1, comments: [] })
  assert.equal(second.status, 409)
  assert.match(await second.text(), /another browser tab owns this review draft/)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, resumed)

  // A second tab cannot finish the review either; otherwise it could submit a
  // stale page and discard the owner's newer comments.
  const rejectedSubmit = await post('submit', { client_id: 'second-tab', comments: [] })
  assert.equal(rejectedSubmit.status, 409)
  assert.match(await rejectedSubmit.text(), /another browser tab owns this review draft/)
  assert.equal((await post('submit', { client_id: 'review-tab', comments: resumed })).status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments: resumed })
})

test('tab closure preserves the draft, allows a brief reconnect, then completes as abandoned', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  const draft = join(directory, 'feedback.draft.json')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: draft,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
    safetyTimeoutMs: 1_000,
    tabCloseGraceMs: 25,
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const comments = [{ id: 'one', comment: 'Recover this' }]

  const firstClose = await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), {
    method: 'POST',
    body: JSON.stringify({ client_id: 'review-tab', revision: 1, comments }),
  })
  assert.equal(firstClose.status, 200)
  const competingHeartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'second-tab' }),
  })
  assert.equal(competingHeartbeat.status, 409)
  const heartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'review-tab' }),
  })
  assert.equal(heartbeat.status, 200)
  const remainedOpen = await Promise.race([
    review.completion.then(() => false),
    new Promise(resolveWait => setTimeout(() => resolveWait(true), 40)),
  ])
  assert.equal(remainedOpen, true)

  const secondClose = await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), {
    method: 'POST',
    body: JSON.stringify({ client_id: 'review-tab', revision: 2, comments }),
  })
  assert.equal(secondClose.status, 200)
  assert.deepEqual(await review.completion, { action: 'abandon', comments: [] })
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, comments)
})

test('the safety timeout completes an otherwise abandoned review', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
    safetyTimeoutMs: 20,
  })
  t.after(() => review.close())

  assert.deepEqual(await review.completion, { action: 'timeout', comments: [] })
})

test('served-page review proxies HTML and assets while removing blocking CSP', async t => {
  let pageOrigin
  let websocketOrigin
  const events = []
  const upstream = createServer((request, response) => {
    if (request.url === '/app') {
      pageOrigin = request.headers.origin
      const body = '<html><body><script src="/app.js"></script>Live app</body></html>'
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'self'",
      })
      response.end(body)
      return
    }
    if (request.url === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('window.appLoaded = true;')
      return
    }
    response.writeHead(404)
    response.end()
  })
  upstream.on('upgrade', (request, socket) => {
    websocketOrigin = request.headers.origin
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolveClose => upstream.close(resolveClose)))
  const review = await createReviewServer({
    source: parseSource(`http://127.0.0.1:${upstreamPort}/app`),
    draftOutput: null,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: (level, message, details) => events.push({ level, message, details }),
  })
  t.after(() => review.close())

  const browserOrigin = 'http://127.0.0.1:65500'
  const pageResponse = await fetch(review.reviewUrl, { headers: { origin: browserOrigin } })
  assert.equal(pageResponse.status, 200)
  assert.equal(pageResponse.headers.get('content-security-policy'), null)
  assert.match(await pageResponse.text(), /Live app.*const endpoint=/s)
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  assert.equal(pageOrigin, upstreamOrigin)
  const assetResponse = await fetch(new URL('/app.js', review.reviewUrl))
  assert.equal(assetResponse.status, 200)
  assert.equal(await assetResponse.text(), 'window.appLoaded = true;')
  const reviewUrl = new URL(review.reviewUrl)
  const handshake = await websocketHandshake(Number(reviewUrl.port), '/socket', browserOrigin)
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.equal(websocketOrigin, upstreamOrigin)
  assert.ok(events.some(event => event.message === 'Review server ready'))

  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'proxy-tab' }),
  })
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
})

test('server shutdown destroys upgraded sockets instead of waiting indefinitely', async t => {
  const upstreamSockets = new Set()
  const upstream = createServer((_request, response) => response.end('<html></html>'))
  upstream.on('upgrade', (_request, socket) => {
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const upstreamPort = await listen(upstream)
  t.after(() => {
    for (const socket of upstreamSockets) socket.destroy()
    return new Promise(resolveClose => upstream.close(resolveClose))
  })
  const review = await createReviewServer({
    source: parseSource(`http://127.0.0.1:${upstreamPort}/app`),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
  })
  t.after(() => review.close())
  const reviewUrl = new URL(review.reviewUrl)
  const socket = await openWebsocket(Number(reviewUrl.port), '/socket', 'http://127.0.0.1:65500')
  t.after(() => socket.destroy())

  const shutdown = await Promise.race([
    review.close().then(() => 'closed'),
    new Promise(resolveWait => setTimeout(() => resolveWait('timed out'), 100)),
  ])
  assert.equal(shutdown, 'closed')
})

test('an unavailable served page returns a visible error instead of hanging', async t => {
  const probe = createServer()
  const unavailablePort = await listen(probe)
  await new Promise(resolveClose => probe.close(resolveClose))
  const events = []
  const review = await createReviewServer({
    source: parseSource(`http://127.0.0.1:${unavailablePort}/missing`),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: (level, message, details) => events.push({ level, message, details }),
  })
  t.after(() => review.close())

  const response = await fetch(review.reviewUrl)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /Could not reach local page/)
  assert.ok(events.some(event => event.level === 'error' && event.message === 'Could not reach served-page source'))

  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'unavailable-tab' }),
  })
  await review.completion
})
