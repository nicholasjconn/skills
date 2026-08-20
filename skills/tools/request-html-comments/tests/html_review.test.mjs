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

function endpointFromHtml(html) {
  const match = /const endpoint\s*=\s*"([^"]+)"/.exec(html)
  assert.ok(match, 'the review page should contain its generated action endpoint')
  return match[1]
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
  )

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

test('file overlay injection preserves non-ASCII restored comments through Latin-1 encoding', () => {
  const comments = [{ id: 'unicode', comment: 'Keep the em dash — and 中文 😀' }]
  const rendered = injectHtml(
    '<html><body>Review me</body></html>',
    '/token',
    comments,
    'globalThis.restoredComments=__INITIAL_COMMENTS__;',
  )
  const encoded = Buffer.from(rendered, 'latin1').toString('latin1')
  const scriptStart = encoded.lastIndexOf('<script>') + '<script>'.length
  const scriptEnd = encoded.indexOf('</script>', scriptStart)
  const target = {}

  new Function('globalThis', encoded.slice(scriptStart, scriptEnd))(target)

  assert.deepEqual(target.restoredComments, comments)
  assert.doesNotMatch(encoded.slice(scriptStart, scriptEnd), /[^\x00-\x7f]/)
})

test('the injected overlay stays inactive inside an iframe', () => {
  const rendered = injectHtml('<html><body>Framed page</body></html>', '/token', [], OVERLAY_SCRIPT)
  const scriptStart = rendered.lastIndexOf('<script>') + '<script>'.length
  const scriptEnd = rendered.indexOf('</script>', scriptStart)
  const runOverlay = new Function('window', rendered.slice(scriptStart, scriptEnd))

  assert.doesNotThrow(() => runOverlay({ top: {} }))
})

test('the overlay has no browser-tab identity or lifecycle endpoints', () => {
  assert.doesNotMatch(OVERLAY_SCRIPT, /sessionStorage|client_id|\/heartbeat|\/abandon/)
})

test('the overlay observes modal visibility attributes and targets dialog hosts', () => {
  assert.match(OVERLAY_SCRIPT, /attributeFilter:\s*\['open',\s*'role',\s*'aria-modal',\s*'class',\s*'style',\s*'hidden',\s*'inert'\]/)
  assert.match(OVERLAY_SCRIPT, /const composedClosest =/)
  assert.match(OVERLAY_SCRIPT, /active\?\.shadowRoot\?\.activeElement/)
  assert.match(OVERLAY_SCRIPT, /if \(node\.shadowRoot\) visit\(node\.shadowRoot\)/)
  assert.match(OVERLAY_SCRIPT, /document\.addEventListener\('focusin', syncOverlayHost, true\)/)
  assert.match(OVERLAY_SCRIPT, /const activeModalHost =/)
})

test('the overlay refreshes comment positions when nested sections scroll', () => {
  assert.match(OVERLAY_SCRIPT, /document\.addEventListener\('scroll',\s*scheduleCommentRefresh,\s*true\)/)
  assert.match(OVERLAY_SCRIPT, /refreshCommentsFrame = requestAnimationFrame/)
})

test('element and text references can cross open shadow-root boundaries', () => {
  assert.match(OVERLAY_SCRIPT, /const shadowPath =/)
  assert.match(OVERLAY_SCRIPT, /shadow_path: shadowPath\(node\)/)
  assert.match(OVERLAY_SCRIPT, /parent_shadow_path: shadowPath\(parent\)/)
  assert.match(OVERLAY_SCRIPT, /const resolveSelectorReference =/)
  assert.match(OVERLAY_SCRIPT, /scope = node\.shadowRoot/)
  assert.match(OVERLAY_SCRIPT, /const eventOrigin = \(event\) => event\.composedPath\(\)/)
})

test('new fallback anchors use explicit viewport coordinates across modal reparenting', () => {
  assert.match(OVERLAY_SCRIPT, /anchor_coordinate_space: draft\.anchorCoordinateSpace/)
  assert.match(OVERLAY_SCRIPT, /anchorCoordinateSpace: 'viewport'/)
  assert.match(OVERLAY_SCRIPT, /item\.anchor_coordinate_space === 'viewport'/)
  assert.match(OVERLAY_SCRIPT, /toContainingBlock\(item\.anchor\.x, item\.anchor\.y\)/)
})

test('the overlay mounts isolated controls in a zero-size popover layer and never pads the host page', () => {
  assert.match(OVERLAY_SCRIPT, /className = 'steward-review-ui sr-layer'/)
  assert.match(OVERLAY_SCRIPT, /setAttribute\('popover', 'manual'\)/)
  assert.match(OVERLAY_SCRIPT, /attachShadow\(\{mode: 'open'\}\)/)
  assert.match(OVERLAY_SCRIPT, /overlayShadow\.appendChild\(overlayStyle\)/)
  assert.match(OVERLAY_SCRIPT, /overlayShadow\.appendChild\(root\)/)
  assert.match(OVERLAY_SCRIPT, /pageStyle\.textContent = '\.steward-review-hover/)
  assert.match(OVERLAY_SCRIPT, /document\.head\.appendChild\(pageStyle\)/)
  assert.match(OVERLAY_SCRIPT, /pointer-events:none!important/)
  assert.match(OVERLAY_SCRIPT, /overlayLayer\.showPopover|showAsPopover\(overlayLayer\)/)
  assert.match(OVERLAY_SCRIPT, /:host, :host\(:popover-open\)/)
  assert.doesNotMatch(OVERLAY_SCRIPT, /dataset\.srChrome/)
  assert.doesNotMatch(OVERLAY_SCRIPT, /paddingTop/)
  assert.match(OVERLAY_SCRIPT, /overlayShadow\.appendChild\(popup\)/)
})

test('the comment editor is a popover and falls back if showPopover fails', () => {
  assert.match(OVERLAY_SCRIPT, /popup\.setAttribute\('popover', 'manual'\)/)
  assert.match(OVERLAY_SCRIPT, /showAsPopover\(popup\)/)
  assert.match(OVERLAY_SCRIPT, /removeAttribute\('popover'\)/)
  assert.match(OVERLAY_SCRIPT, /const visibleClipRect =/)
  assert.match(OVERLAY_SCRIPT, /placeFixedElement\(popup/)
})

test('overlay chrome is clipped to the viewport, not the host dialog', () => {
  assert.match(OVERLAY_SCRIPT, /const visibleClipRect = \(\) => viewportClipRect\(\)/)
  assert.doesNotMatch(OVERLAY_SCRIPT, /style\.overflow !== 'visible'/)
})

test('reparenting into a modal keeps overlay screen position and does not replay enter animations', () => {
  assert.match(OVERLAY_SCRIPT, /const toolbarRect = copyRect\(root\)/)
  assert.match(OVERLAY_SCRIPT, /restoreFixedPosition\(root, toolbarRect\)/)
  assert.match(OVERLAY_SCRIPT, /\.steward-review-popup\.sr-enter/)
  assert.match(OVERLAY_SCRIPT, /\.steward-review-pin\.sr-enter/)
  assert.doesNotMatch(
    OVERLAY_SCRIPT,
    /\.steward-review-popup \{[^}]*animation:/
  )
})

test('file review serves relative local assets, persists drafts, and accepts feedback', async t => {
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
  const endpoint = endpointFromHtml(await pageResponse.text())
  const assetResponse = await fetch(new URL('page.css', review.reviewUrl))
  assert.equal(assetResponse.status, 200)
  assert.equal(await assetResponse.text(), 'body { color: red; }')
  if (process.platform !== 'win32') {
    const escapedResponse = await fetch(new URL('/escaped.txt', review.reviewUrl))
    assert.equal(escapedResponse.status, 404)
  }

  const comments = [{ id: 'one', target_type: 'text', comment: 'Clarify this' }]
  const draftResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comments, deleted_ids: [] }),
  })
  assert.equal(draftResponse.status, 200)
  const persisted = JSON.parse(readFileSync(draft, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.deepEqual(persisted.source, { type: 'file', value: html })
  assert.deepEqual(persisted.comments, comments)

  // Retrying the same operation is harmless.
  const retryResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comments, deleted_ids: [] }),
  })
  assert.equal(retryResponse.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, comments)

  const submitResponse = await fetch(new URL(`${endpoint}/submit`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(submitResponse.status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments })
})

test('reloads and additional tabs share recoverable comments without ownership', async t => {
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
  const endpoint = endpointFromHtml(await (await fetch(review.reviewUrl)).text())
  const post = (action, payload) => fetch(new URL(`${endpoint}/${action}`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const firstTabComment = { id: 'one', comment: 'Keep this through the reload' }
  const secondTabComment = { id: 'two', comment: 'Added from another tab' }

  assert.equal((await post('draft', { comments: [firstTabComment], deleted_ids: [] })).status, 200)

  // A reload receives the latest server-side draft in the injected overlay.
  assert.match(await (await fetch(review.reviewUrl)).text(), /Keep this through the reload/)

  // Another tab contributes only its change. It never replaces comments it
  // did not load, and replaying its request does not duplicate anything.
  const secondPayload = { comments: [secondTabComment], deleted_ids: [] }
  assert.equal((await post('draft', secondPayload)).status, 200)
  assert.equal((await post('draft', secondPayload)).status, 200)
  const combined = [firstTabComment, secondTabComment]
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, combined)

  // A newly opened page sees the combined server draft, and submission uses
  // that draft rather than a possibly stale tab-local snapshot.
  const reopenedHtml = await (await fetch(review.reviewUrl)).text()
  assert.match(reopenedHtml, /Keep this through the reload/)
  assert.match(reopenedHtml, /Added from another tab/)
  assert.equal((await post('submit', {})).status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments: combined })
})

test('comment deletion is idempotent and the worker ignores browser lifecycle', async t => {
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
    safetyTimeoutMs: 30,
  })
  t.after(() => review.close())
  const endpoint = endpointFromHtml(await (await fetch(review.reviewUrl)).text())
  const comments = [{ id: 'one', comment: 'Remove this' }, { id: 'two', comment: 'Keep this' }]
  const save = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comments, deleted_ids: [] }),
  })
  assert.equal(save.status, 200)
  for (let retry = 0; retry < 2; retry += 1) {
    const deletion = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comments: [], deleted_ids: ['one'] }),
    })
    assert.equal(deletion.status, 200)
  }
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, [comments[1]])
  assert.equal((await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), { method: 'POST' })).status, 404)
  assert.equal((await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), { method: 'POST' })).status, 404)
  assert.deepEqual(await review.completion, { action: 'timeout', comments: [] })
})

test('the safety timeout completes an otherwise idle review', async t => {
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

test('request filesystem failures return an error without ending the review worker', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const events = []
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: null,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: (level, message, details) => events.push({ level, message, details }),
  })
  t.after(() => review.close())
  const endpoint = endpointFromHtml(await (await fetch(review.reviewUrl)).text())
  rmSync(directory, { recursive: true, force: true })

  const failedAsset = await fetch(new URL('/missing.css', review.reviewUrl))
  assert.equal(failedAsset.status, 500)
  assert.equal(await failedAsset.text(), 'Review request failed')
  assert.ok(events.some(event => event.level === 'error' && event.message === 'Review request failed'))

  const cancel = await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(cancel.status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
})

test('served-page review proxies HTML and assets while removing blocking CSP', async t => {
  let pageOrigin
  let websocketOrigin
  const upstream = createServer((request, response) => {
    if (request.url === '/app?theme=dark') {
      pageOrigin = request.headers.origin
      const body = '<html><body><script src="app.js"></script>Live app</body></html>'
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
    source: parseSource(`http://127.0.0.1:${upstreamPort}/app?theme=dark`),
    draftOutput: null,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: () => {},
  })
  t.after(() => review.close())

  const browserOrigin = new URL(review.reviewUrl).origin
  const pageResponse = await fetch(review.reviewUrl, {
    headers: { origin: browserOrigin, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(pageResponse.status, 200)
  assert.equal(pageResponse.headers.get('content-security-policy'), null)
  const pageHtml = await pageResponse.text()
  const endpoint = endpointFromHtml(pageHtml)
  assert.match(pageHtml, /Live app.*const endpoint=/s)
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  assert.equal(pageOrigin, upstreamOrigin)
  const assetResponse = await fetch(new URL('app.js', review.reviewUrl))
  assert.equal(assetResponse.status, 200)
  assert.equal(await assetResponse.text(), 'window.appLoaded = true;')
  const reviewUrl = new URL(review.reviewUrl)
  const handshake = await websocketHandshake(Number(reviewUrl.port), '/socket', browserOrigin)
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.equal(websocketOrigin, upstreamOrigin)
  const crossOriginResponse = await fetch(review.reviewUrl, {
    headers: { origin: 'https://example.com' },
  })
  assert.equal(crossOriginResponse.status, 403)
  const crossSiteResponse = await fetch(review.reviewUrl, {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSiteResponse.status, 403)
  const rejectedHandshake = await websocketHandshake(Number(reviewUrl.port), '/socket', 'https://example.com')
  assert.match(rejectedHandshake, /^HTTP\/1\.1 403 Forbidden/)
  await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
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
  const socket = await openWebsocket(Number(reviewUrl.port), '/socket', reviewUrl.origin)
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
})

test('a stalled served page times out and releases the proxied request', async t => {
  const upstream = createServer(() => {})
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolveClose => upstream.close(resolveClose)))
  const events = []
  const review = await createReviewServer({
    source: parseSource(`http://127.0.0.1:${upstreamPort}/stalled`),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: (level, message, details) => events.push({ level, message, details }),
    upstreamTimeoutMs: 20,
  })
  t.after(() => review.close())

  const response = await fetch(review.reviewUrl)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /did not respond in time/)
  assert.ok(events.some(event => (
    event.level === 'error'
    && event.message === 'Could not reach served-page source'
    && /did not respond in time/.test(event.details.error)
  )))
})

test('localhost served-page reviews retain the localhost browser hostname', async t => {
  const upstream = createServer((_request, response) => response.end('<html><body>Local session</body></html>'))
  const upstreamPort = await new Promise((resolveListen, rejectListen) => {
    upstream.once('error', rejectListen)
    upstream.listen(0, 'localhost', () => resolveListen(upstream.address().port))
  })
  t.after(() => new Promise(resolveClose => upstream.close(resolveClose)))
  const review = await createReviewServer({
    source: parseSource(`http://localhost:${upstreamPort}/session`),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
  })
  t.after(() => review.close())

  assert.equal(new URL(review.reviewUrl).hostname, 'localhost')
  assert.equal((await fetch(review.reviewUrl)).status, 200)
})
