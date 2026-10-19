import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createReviewServer, injectHtml, loadRestoredComments, parseArgs,
  parseSource, sourceIdentity, logPath, validateReviewHost,
} from '../scripts/html_review.mjs'

const script = fileURLToPath(new URL('../scripts/html_review.mjs', import.meta.url))
const GEOMETRY_SCRIPT = readFileSync(new URL('../scripts/review_geometry.js', import.meta.url), 'utf8')
const overlayScript = 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;'
const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'html-review-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function startReview(t, source, options = {}) {
  const review = await createReviewServer({ source, draftOutput: null, initialComments: [], overlayScript, log: () => {}, ...options })
  t.after(() => review.close())
  return review
}

async function fileReview(t, options = {}) {
  const directory = temporaryDirectory(t)
  const served = join(directory, 'served')
  mkdirSync(served)
  const html = join(served, 'page.html')
  const draftOutput = join(directory, 'feedback.draft.json')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await startReview(t, parseSource(html), { draftOutput, ...options })
  return { ...review, directory, served, html, draftOutput }
}

function listen(t, server) {
  t.after(() => new Promise(resolve => server.close(resolve)))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(url, { body, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const send = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest
    const outgoing = send(url, options, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }))
      response.on('error', reject)
    })
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('test request timed out')))
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

function post(review, action, payload = {}) {
  return request(new URL(`${review.endpoint}/${action}`, review.reviewUrl), { method: 'POST', body: JSON.stringify(payload) })
}

test('source and CLI parsing reject unsupported inputs and unsafe TLS paths', t => {
  const directory = temporaryDirectory(t)
  const served = join(directory, 'served')
  mkdirSync(served)
  const html = join(served, 'page.html')
  const cert = join(directory, 'cert.pem')
  const key = join(served, 'key.pem')
  writeFileSync(html, '<html></html>')
  writeFileSync(cert, 'test certificate')
  writeFileSync(key, 'test key')
  assert.deepEqual(sourceIdentity(parseSource(html)), { type: 'file', value: html })
  assert.deepEqual(sourceIdentity(parseSource('http://localhost:3000/path')), { type: 'url', value: 'http://localhost:3000/path' })
  for (const source of ['https://localhost:3000', 'http://example.com']) {
    assert.throws(() => parseSource(source), /http:\/\/ loopback URL/)
  }
  assert.throws(() => parseSource(join(directory, 'missing.html')), /existing .html/)
  const args = parseArgs([html, '--async', '--output', join(directory, 'feedback.json'), '--no-open', '--port', '56158'])
  assert.equal(args.no_open, true)
  assert.equal(args.port, 56158)
  for (const port of ['0', '65536']) assert.throws(() => parseArgs([html, '--port', port]), /integer from 1 to 65535/)
  assert.throws(() => parseArgs([html, '--tls-cert', cert]), /must be given together/)
  assert.throws(() => parseArgs([html, '--tls-cert', directory, '--tls-key', key]), /existing PEM file/)
  const tlsArgs = keyPath => [html, '--tls-cert', cert, '--tls-key', keyPath]
  assert.throws(() => parseArgs(tlsArgs(key)), /outside the reviewed file directory tree/)
  if (process.platform !== 'win32') {
    const link = join(directory, 'key-link.pem')
    symlinkSync(key, link)
    assert.throws(() => parseArgs(tlsArgs(link)), /outside the reviewed file directory tree/)
  }
  const safeKey = join(directory, 'safe.pem')
  writeFileSync(safeKey, 'test key')
  assert.equal(parseArgs(tlsArgs(safeKey)).tls_key, safeKey)
})

test('LAN host validation requires an exact active non-loopback IPv4 address', () => {
  const interfaces = {
    en0: [{ address: '192.0.2.44', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  }
  assert.equal(validateReviewHost('192.0.2.44', interfaces), '192.0.2.44')
  for (const rejected of ['localhost', '127.0.0.1', '192.0.2.44:3000', '192.0.2.45']) {
    assert.throws(() => validateReviewHost(rejected, interfaces), /--host/)
  }
})

test('restore accepts both artifact versions but rejects malformed or unrelated feedback', t => {
  const directory = temporaryDirectory(t)
  const source = parseSource('http://localhost:3100/review-me')
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html></html>')
  const artifact = join(directory, 'feedback.json')
  const comments = [{ id: 'one', comment: 'Keep this', iframe_path: [{ css_selector: '#frame', tag: 'iframe' }] }]
  for (const version of [1, 2]) {
    const restoredSource = version === 1 ? parseSource(html) : source
    writeFileSync(artifact, JSON.stringify({ version, source: version === 1 ? html : sourceIdentity(source), comments }))
    assert.deepEqual(loadRestoredComments(artifact, restoredSource), comments)
    assert.throws(() => loadRestoredComments(artifact, parseSource('http://localhost:3100/another-page')), /different source/)
  }
  writeFileSync(artifact, JSON.stringify({ version: 2, source: sourceIdentity(source), comments: [{ id: 'broken' }] }))
  assert.throws(() => loadRestoredComments(artifact, source), /comments list/)
})

test('injection keeps Unicode, script delimiters and replacement patterns inert', () => {
  const comments = [{ id: 'one', comment: 'Keep </script> — 中文 😀 __ENDPOINT__ __INITIAL_COMMENTS__ $& $`' }]
  const html = injectHtml('<html><body>Review</body></html>', '/token', comments, 'return [__ENDPOINT__,__INITIAL_COMMENTS__]')
  const encoded = Buffer.from(html, 'latin1').toString('latin1')
  const start = encoded.lastIndexOf('<script>') + '<script>'.length
  const end = encoded.indexOf('</script>', start)
  assert.ok(end < encoded.lastIndexOf('</body>'))
  assert.doesNotMatch(encoded.slice(start, end), /[^\x00-\x7f]/)
  assert.deepEqual(new Function(encoded.slice(start, end))(), ['/token', comments])
})

test('frame geometry maps, clips, and rejects unsupported transforms', () => {
  const nodeModule = { exports: {} }
  new Function('module', GEOMETRY_SCRIPT)(nodeModule)
  const geometry = nodeModule.exports
  const geometryForFrames = {
    source: { left: 0, top: 0, right: 100, bottom: 50 },
    hops: [
      {
        scaleX: 2,
        scaleY: 2,
        content: { left: 10, top: 20, right: 210, bottom: 120 },
        visibleClip: { left: 0, top: 0, right: 210, bottom: 120 },
        parentSource: { left: 0, top: 0, right: 220, bottom: 130 },
      },
      {
        scaleX: 0.5,
        scaleY: 0.5,
        content: { left: 100, top: 50, right: 210, bottom: 115 },
        visibleClip: { left: 100, top: 50, right: 200, bottom: 105 },
        parentSource: { left: 0, top: 0, right: 240, bottom: 150 },
      },
    ],
  }

  assert.deepEqual(geometry.mapPointToTop(20, 10, geometryForFrames), { x: 125, y: 70 })
  assert.deepEqual(geometry.mapRectToTop({ left: 10, top: 5, width: 30, height: 20 }, geometryForFrames), {
    left: 115, top: 65, right: 145, bottom: 85, width: 30, height: 20,
  })
  assert.equal(geometry.mapPointToTop(101, 10, geometryForFrames), null)
  assert.deepEqual(
    geometry.intersectClippedAxes({ left: 0, top: 0, right: 30, bottom: 30 }, { left: 10, top: 10, right: 20, bottom: 20 }, true, false),
    { left: 10, top: 0, right: 20, bottom: 30, width: 10, height: 30 },
  )
  assert.deepEqual(geometry.clampPinToClip(3, 40, { left: 0, top: 0, right: 40, bottom: 40 }), { x: 15.5, y: 24.5 })
  assert.equal(geometry.isAxisAlignedTransform('matrix(2, 0, 0, 3, 10, 20)'), true)
  assert.equal(geometry.isAxisAlignedTransform('matrix(1, 0.2, 0, 1, 0, 0)'), false)
  assert.equal(typeof geometry.mapPointToTop, 'function')
  assert.equal(globalThis.__stewardReviewGeometry, undefined)
})

test('file review serves safe assets and merges, retries, deletes and restores shared drafts', async t => {
  const review = await fileReview(t)
  writeFileSync(join(review.served, 'page.css'), 'body { color: red; }')
  writeFileSync(join(review.directory, 'private.txt'), 'private')
  if (process.platform !== 'win32') {
    symlinkSync(join(review.directory, 'private.txt'), join(review.served, 'escaped.txt'))
    assert.equal((await request(new URL('/escaped.txt', review.reviewUrl))).status, 404)
  }
  assert.equal((await request(new URL('/page.css', review.reviewUrl))).text, 'body { color: red; }')
  const first = { id: 'one', comment: 'First tab' }
  const second = { id: 'two', comment: 'Second tab' }
  assert.equal((await post(review, 'draft', { comments: [first] })).status, 200)
  assert.match((await request(review.reviewUrl)).text, /First tab/)
  for (let retry = 0; retry < 2; retry++) {
    assert.equal((await post(review, 'draft', { comments: [second] })).status, 200)
  }
  const persisted = JSON.parse(readFileSync(review.draftOutput, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.deepEqual(persisted.source, { type: 'file', value: review.html })
  assert.deepEqual(persisted.comments, [first, second])
  assert.match((await request(review.reviewUrl)).text, /Second tab/)
  for (let retry = 0; retry < 2; retry++) {
    assert.equal((await post(review, 'draft', { comments: [], deleted_ids: ['one'] })).status, 200)
  }
  assert.deepEqual(JSON.parse(readFileSync(review.draftOutput, 'utf8')).comments, [second])
  assert.equal((await post(review, 'submit')).status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments: [second] })
})

test('file review limits external navigation to its exact entry and protects control endpoints', async t => {
  const review = await fileReview(t)
  writeFileSync(join(review.served, 'other.html'), '<h1>Other</h1>')
  const url = new URL(review.reviewUrl)
  const get = (path, headers) => request(new URL(path, url), { headers })
  assert.equal((await get(url.pathname, navigation)).status, 200)
  for (const path of [`${url.pathname}?changed=1`, '/other.html', `${review.endpoint}/ready`]) {
    assert.equal((await get(path, navigation)).status, 403)
  }
  assert.equal((await get(url.pathname, { host: `localhost:${url.port}` })).status, 403)
  assert.equal((await get(url.pathname, { origin: 'https://example.com' })).status, 403)
  for (const action of ['heartbeat', 'abandon']) assert.equal((await post(review, action)).status, 404)
  assert.equal((await post(review, 'cancel')).status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
})

test('app proxy injects HTML, serves assets and permits document returns without exposing controls', async t => {
  const reached = []
  const upstream = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`)
    if (req.headers.origin) assert.equal(req.headers.origin, `http://127.0.0.1:${port}`)
    res.writeHead(200, { 'content-type': req.url === '/app.js' ? 'text/javascript' : 'text/html', 'content-security-policy': "script-src 'self'" })
    res.end(req.url === '/app.js' ? 'window.appLoaded = true;' : '<html><body>Live app</body></html>')
  })
  const port = await listen(t, upstream)
  const review = await startReview(t, parseSource(`http://127.0.0.1:${port}/sign-in`))
  const page = await request(review.reviewUrl, { headers: { origin: new URL(review.reviewUrl).origin } })
  assert.equal(page.status, 200)
  assert.equal(page.headers['content-security-policy'], undefined)
  assert.match(page.text, /Live app.*const endpoint=/s)
  assert.equal((await request(new URL('/app.js', review.reviewUrl))).text, 'window.appLoaded = true;')
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(new URL('/account?code=synthetic', review.reviewUrl), { method, headers: navigation })).status, 200)
    assert.equal(reached.at(-1), `${method} /account?code=synthetic`)
  }
  const before = reached.length
  const blocked = [
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { ...navigation, 'Sec-Fetch-Mode': 'cors' } },
    { headers: { ...navigation, 'Sec-Fetch-Dest': 'iframe' } },
    { method: 'POST', headers: navigation },
    { method: 'PUT', headers: navigation },
  ]
  for (const options of blocked) assert.equal((await request(review.reviewUrl, options)).status, 403)
  for (const action of ['', '/ready', '/draft', '/submit', '/cancel']) {
    for (const method of ['GET', 'POST']) {
      assert.equal((await request(new URL(`${review.endpoint}${action}`, review.reviewUrl), { method, headers: navigation })).status, 403)
    }
  }
  assert.equal(reached.length, before, 'rejected requests must not reach the app')
})

test('bind and upstream failures report useful errors rather than hanging', async t => {
  const upstream = createServer(() => {})
  const port = await listen(t, upstream)
  const review = await startReview(t, parseSource(`http://127.0.0.1:${port}/stalled`), { upstreamTimeoutMs: 20 })
  await assert.rejects(startReview(t, parseSource(`http://127.0.0.1:${port}/`), { port }), /could not bind.*EADDRINUSE/)
  const stalled = await request(review.reviewUrl)
  assert.equal(stalled.status, 502)
  assert.match(stalled.text, /did not respond in time/)
  await new Promise(resolve => upstream.close(resolve))
  const unavailable = await request(review.reviewUrl)
  assert.equal(unavailable.status, 502)
  assert.match(unavailable.text, /Could not reach local page/)
})

test('filesystem failures leave cancellation available and idle reviews still time out', async t => {
  const review = await fileReview(t)
  rmSync(review.served, { recursive: true })
  const failure = await request(new URL('/missing.css', review.reviewUrl))
  assert.equal(failure.status, 500)
  assert.equal(failure.text, 'Review request failed')
  assert.equal((await post(review, 'cancel')).status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
  const idle = await fileReview(t, { safetyTimeoutMs: 20 })
  assert.deepEqual(await idle.completion, { action: 'timeout', comments: [] })
})

test('invalid async input leaves a diagnostic log', t => {
  const output = join(temporaryDirectory(t), 'feedback.json')
  const result = spawnSync(process.execPath, [script, 'http://example.com/page', '--async', '--output', output], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /loopback URL/)
  assert.match(readFileSync(logPath(output), 'utf8'), /loopback URL/)
})

test('async TLS CLI forwards launch options and retains attributable readiness evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'html-review-test-'))
  const served = join(directory, 'served')
  mkdirSync(served)
  const html = join(served, 'page.html')
  const output = join(directory, 'feedback.json')
  const key = join(directory, 'key.pem')
  const cert = join(directory, 'cert.pem')
  writeFileSync(html, '<html><body>Secure review</body></html>')
  let workerPid
  t.after(async () => {
    // Stop the detached worker before deleting files it may still be writing.
    if (workerPid) {
      try { process.kill(workerPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        try { process.kill(workerPid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    rmSync(directory, { recursive: true, force: true })
  })
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert,
  ])
  if (certificate.error?.code === 'ENOENT') return t.skip('openssl is unavailable')
  assert.equal(certificate.status, 0, String(certificate.stderr))
  const reservation = createServer()
  const port = await listen(t, reservation)
  await new Promise(resolve => reservation.close(resolve))
  const launched = spawnSync(process.execPath, [
    script, html, '--async', '--output', output, '--no-open', '--port', String(port),
    '--tls-cert', cert, '--tls-key', key,
  ], { encoding: 'utf8', timeout: 15_000 })
  const log = readFileSync(logPath(output), 'utf8')
  const detached = log.split('\n').find(line => line.includes(' INFO Detached review worker '))
  const record = detached && JSON.parse(detached.slice(detached.indexOf('{')))
  workerPid = record?.worker_pid
  assert.equal(launched.status, 0, launched.stderr)
  assert.ok(workerPid, 'log must identify the detached worker')
  const ready = /Review URL: (https:\/\/\S+)/.exec(launched.stdout)?.[1]
  assert.equal(new URL(ready).port, String(port))
  assert.equal(typeof record.ready_file, 'string', 'worker log must name its retained readiness file')
  assert.equal(readFileSync(record.ready_file, 'utf8'), `${ready}\n`)
  assert.match(log, /Skipped default browser launch/)
  const ca = readFileSync(cert)
  const page = await request(ready, { ca })
  assert.equal(page.status, 200)
  const endpoint = /const endpoint\s*=\s*"([^"]+)"/.exec(page.text)?.[1]
  assert.ok(endpoint)
  const control = new URL(`${endpoint}/draft`, ready)
  const origin = new URL(ready).origin
  assert.equal((await request(control, { ca, method: 'POST', headers: { origin }, body: '{"comments":[]}' })).status, 200)
  assert.equal((await request(control, { ca, method: 'POST', headers: { origin: origin.replace('https:', 'http:') }, body: '{}' })).status, 403)
  assert.equal((await request(new URL(`${endpoint}/cancel`, ready), { ca, method: 'POST', body: '{}' })).status, 200)
})

test('local adapter persists patches and reports HTTP failures before completion', async () => {
  const { runInNewContext } = await import('node:vm');
  const calls = [];
  let options;
  const context = {
    window: {}, Blob,
    createHtmlReview: value => { options = value; },
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
    navigator: { sendBeacon: () => false },
    document: { documentElement: { innerHTML: '' } },
  };
  context.window.top = context.window;
  const source = readFileSync(fileURLToPath(new URL('../scripts/review_local.js', import.meta.url)), 'utf8')
    .replace('__ENDPOINT__', JSON.stringify('/review-test')).replace('__INITIAL_COMMENTS__', '[]');
  runInNewContext(source, context);
  await options.saveDraft({ comments: [{ id: 'a', comment: 'Feedback' }], deleted_ids: [] });
  assert.equal(calls[0].url, '/review-test/draft');
  assert.equal(JSON.parse(calls[0].init.body).comments[0].comment, 'Feedback');
  await options.onFinish('submit');
  assert.match(context.document.documentElement.innerHTML, /Review submitted/);
  context.fetch = async () => ({ ok: false, text: async () => 'Disk full' });
  await assert.rejects(options.saveDraft({ comments: [], deleted_ids: [] }), /Disk full/);
});

test('an upload started before submission cannot replace saved feedback afterward', async t => {
  const comments = [{ id: 'saved', comment: 'Original feedback' }]
  const review = await fileReview(t, { initialComments: comments })
  const draft = review.draftOutput
  writeFileSync(draft, JSON.stringify({ comments }))
  const originalDraft = readFileSync(draft, 'utf8')
  const body = JSON.stringify({ comments: [{ id: 'late', comment: 'Rejected feedback' }] })
  const request = httpRequest(new URL(`${review.endpoint}/draft`, review.reviewUrl), {
    method: 'POST', headers: { Expect: '100-continue', 'Content-Length': Buffer.byteLength(body) },
  })
  t.after(() => request.destroy())
  const result = new Promise((resolve, reject) => {
    request.once('error', reject)
    request.once('response', response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
  })
  // Accept headers first, but hold the body until another request submits.
  await new Promise((resolve, reject) => {
    request.once('continue', resolve)
    request.once('error', reject)
    request.flushHeaders()
  })
  const response = await fetch(new URL(`${review.endpoint}/submit`, review.reviewUrl), { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments })
  request.end(body)
  assert.equal(await result, 409)
  assert.equal(readFileSync(draft, 'utf8'), originalDraft)
})
