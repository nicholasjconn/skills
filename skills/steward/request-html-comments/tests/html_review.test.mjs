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
  DRAFT_IDENTIFIER_MAX_LENGTH,
  EARLY_HANDOFF_CANDIDATE_LIMIT,
  createDraftSession,
  createReviewServer,
  injectHtml,
  loadRestoredComments,
  parseSource,
  sourceIdentity,
  draftPath,
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

function memoryStorage(entries = []) {
  const values = new Map(entries)
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    entries: () => [...values.entries()],
  }
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

test('companion paths preserve the established sidecar names', () => {
  assert.equal(draftPath('/tmp/review.json'), '/tmp/review.draft.json')
  assert.equal(logPath('/tmp/review.json'), '/tmp/review.log')
})

test('draft sessions reject invalid persisted state as a complete unit', () => {
  const initialComments = [{ id: 'initial', comment: 'Start here' }]
  const invalidStates = [
    { clientId: 'client-old', revision: Number.MAX_SAFE_INTEGER, comments: initialComments, handoffCredential: null },
    { clientId: 'client-old', revision: 2, comments: [{ id: 'broken' }], handoffCredential: null },
    { clientId: 'client-old', revision: 2, comments: 'not-a-list', handoffCredential: null },
    { clientId: 'x'.repeat(DRAFT_IDENTIFIER_MAX_LENGTH + 1), revision: 2, comments: initialComments, handoffCredential: null },
    { clientId: 'client-old', revision: 2, comments: initialComments, handoffCredential: 'x'.repeat(DRAFT_IDENTIFIER_MAX_LENGTH + 1) },
  ]

  for (const [index, invalidState] of invalidStates.entries()) {
    const storage = memoryStorage([['draft', JSON.stringify(invalidState)]])
    const errors = []
    let sequence = 0
    const session = createDraftSession(storage, 'draft', () => `new-${index}-${++sequence}`, initialComments, message => errors.push(message))
    assert.equal(session.clientId, `new-${index}-1`)
    assert.equal(session.revision, 0)
    assert.deepEqual(session.comments, initialComments)
    assert.match(errors.join('\n'), /stored review draft state is invalid/i)
  }
})

test('draft sessions surface inaccessible storage while keeping in-memory revisions monotonic', () => {
  const errors = []
  const storage = {
    getItem: () => { throw new Error('read denied') },
    setItem: () => { throw new Error('write denied') },
  }
  let sequence = 0
  const session = createDraftSession(storage, 'draft', () => `generated-${++sequence}`, [], message => errors.push(message))
  const comments = [{ id: 'one', comment: 'Still save this load' }]

  assert.equal(session.nextRevision(comments), 1)
  assert.equal(session.nextRevision(comments), 2)
  assert.deepEqual(session.comments, comments)
  assert.match(errors.join('\n'), /read denied/)
  assert.match(errors.join('\n'), /write denied/)
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
  const log = readFileSync(logPath(output), 'utf8')
  assert.match(log, /ERROR Review could not start/)
  assert.match(log, /loopback URL/)
})

test('restore accepts legacy file artifacts and rejects another source', t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  const other = join(directory, 'other.html')
  const artifact = join(directory, 'review.json')
  writeFileSync(html, '<html></html>')
  writeFileSync(other, '<html></html>')
  const comments = [{ id: 'one', comment: 'Keep this' }]
  writeFileSync(artifact, JSON.stringify({ version: 1, source: html, comments }))

  assert.deepEqual(loadRestoredComments(artifact, parseSource(html)), comments)
  assert.throws(() => loadRestoredComments(artifact, parseSource(other)), /different source/)
})

test('restore accepts the versioned served-page source identity', t => {
  const directory = temporaryDirectory(t)
  const artifact = join(directory, 'review.json')
  const source = parseSource('http://localhost:3100/review-me')
  const comments = [{ id: 'one', comment: 'Keep this' }]
  writeFileSync(artifact, JSON.stringify({ version: 2, source: sourceIdentity(source), comments }))

  assert.deepEqual(loadRestoredComments(artifact, source), comments)
  assert.throws(
    () => loadRestoredComments(artifact, parseSource('http://localhost:3100/another-page')),
    /different source/,
  )
})

test('overlay injection keeps comments script-safe and preserves the existing controls', () => {
  const rendered = injectHtml(
    '<html><head></head><body>Review me</body></html>',
    '/token',
    [{ id: 'one', comment: 'Keep </script> and __ENDPOINT__ __INITIAL_COMMENTS__ __CREATE_DRAFT_SESSION__ __DRAFT_IDENTIFIER_MAX_LENGTH__ safe' }],
    OVERLAY_SCRIPT,
    true,
  )

  assert.match(rendered, /<base href="\/">/)
  assert.match(rendered, /<link rel="icon" href="data:,">/)
  assert.match(rendered, /Keep \\u003c\/script>/)
  assert.match(rendered, /const endpoint = "\/token"/)
  assert.match(rendered, /class="sr-add"/)
  assert.match(rendered, /Send review comments/)
  assert.match(rendered, /class="sr-text-toggle"/)
  assert.match(rendered, /class="sr-icon sr-info"/)
  assert.match(rendered, /Created by Nick Conn/)
  assert.match(rendered, /https:\/\/x\.com\/nicholasjconn/)
  assert.match(rendered, /https:\/\/github\.com\/nicholasjconn\/skills/)
  assert.match(rendered, /steward-review-highlight/)
  assert.match(rendered, /Could not preserve review draft across reloads/)
  assert.ok(rendered.indexOf('<style>') < rendered.indexOf('</body>'))
  const scriptStart = rendered.lastIndexOf('<script>') + '<script>'.length
  const scriptEnd = rendered.indexOf('</script>', scriptStart)
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
  const events = []
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: draft,
    initialComments: [],
    overlayScript: 'const endpoint=__ENDPOINT__;const comments=__INITIAL_COMMENTS__;',
    log: (level, message, details) => events.push({ level, message, details }),
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
    body: JSON.stringify({ client_id: 'primary-tab', instance_id: 'primary-page', revision: 3, comments }),
  })
  assert.equal(draftResponse.status, 200)
  const persisted = JSON.parse(readFileSync(draft, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.deepEqual(persisted.source, { type: 'file', value: html })
  assert.deepEqual(persisted.comments, comments)

  const conflictingResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'duplicate-tab', instance_id: 'duplicate-page', revision: 4, comments: [] }),
  })
  assert.equal(conflictingResponse.status, 409)
  assert.match(await conflictingResponse.text(), /another browser tab owns this review draft/)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, comments)

  const staleResponse = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'primary-tab', instance_id: 'primary-page', revision: 2, comments: [] }),
  })
  assert.equal(staleResponse.status, 409)
  assert.match(await staleResponse.text(), /draft revision is stale/)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, comments)

  const submitResponse = await fetch(new URL(`${endpoint}/submit`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'primary-tab', instance_id: 'primary-page', handoff_credential: null, comments }),
  })
  assert.equal(submitResponse.status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments })
  assert.ok(events.some(event => event.message === 'Saved recoverable draft'))
  assert.ok(events.some(event => event.message === 'Rejected conflicting draft writer'))
  assert.ok(events.some(event => event.message === 'Rejected stale draft revision'))
  assert.ok(events.some(event => event.message === 'Review submitted'))
})

test('review ownership identifiers reject oversized values', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const post = (action, payload) => fetch(new URL(`${endpoint}/${action}`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const oversized = 'x'.repeat(DRAFT_IDENTIFIER_MAX_LENGTH + 1)

  const oversizedClient = await post('heartbeat', { client_id: oversized, instance_id: 'owner-page' })
  assert.equal(oversizedClient.status, 400)
  assert.match(await oversizedClient.text(), /client_id must not exceed/)

  const owner = { client_id: 'owner-client', instance_id: 'owner-page', handoff_credential: null }
  assert.equal((await post('heartbeat', owner)).status, 200)

  const oversizedInstance = await post('heartbeat', { ...owner, instance_id: oversized })
  assert.equal(oversizedInstance.status, 400)
  assert.match(await oversizedInstance.text(), /instance_id must not exceed/)
  const oversizedHandoff = await post('heartbeat', { ...owner, handoff_credential: oversized })
  assert.equal(oversizedHandoff.status, 400)
  assert.match(await oversizedHandoff.text(), /handoff_credential must not exceed/)
  const oversizedNextHandoff = await post('abandon', {
    ...owner,
    next_handoff_credential: oversized,
    revision: 1,
    comments: [],
  })
  assert.equal(oversizedNextHandoff.status, 400)
  assert.match(await oversizedNextHandoff.text(), /next_handoff_credential must not exceed/)

  assert.equal((await post('cancel', owner)).status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
})

test('early handoff candidates enforce their cap and release a consumed slot', async t => {
  const directory = temporaryDirectory(t)
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html><body>Review me</body></html>')
  const review = await createReviewServer({
    source: parseSource(html),
    draftOutput: null,
    initialComments: [],
    overlayScript: OVERLAY_SCRIPT,
    log: () => {},
    tabCloseGraceMs: 1_000,
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const post = (action, payload) => fetch(new URL(`${endpoint}/${action}`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const clientId = 'bounded-client'
  const owner = { client_id: clientId, instance_id: 'owner-page', handoff_credential: null }
  assert.equal((await post('heartbeat', owner)).status, 200)

  for (let index = 0; index < EARLY_HANDOFF_CANDIDATE_LIMIT; index += 1) {
    const candidate = await post('heartbeat', {
      client_id: clientId,
      instance_id: `candidate-page-${index}`,
      handoff_credential: `candidate-credential-${index}`,
    })
    assert.equal(candidate.status, 202)
  }
  const overflow = await post('heartbeat', {
    client_id: clientId,
    instance_id: 'overflow-page',
    handoff_credential: 'overflow-credential',
  })
  assert.equal(overflow.status, 409)
  assert.match(await overflow.text(), /too many pending reload handoffs/)

  const abandon = await post('abandon', {
    ...owner,
    next_handoff_credential: 'candidate-credential-0',
    revision: 1,
    comments: [],
  })
  assert.equal(abandon.status, 200)
  const replacement = await post('heartbeat', {
    client_id: clientId,
    instance_id: 'replacement-page',
    handoff_credential: 'replacement-credential',
  })
  assert.equal(replacement.status, 202)

  const currentOwner = { client_id: clientId, instance_id: 'candidate-page-0', handoff_credential: 'candidate-credential-0' }
  assert.equal((await post('cancel', currentOwner)).status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
})

test('same-tab reload resumes its draft while a competing tab remains blocked', async t => {
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
    tabCloseGraceMs: 1_000,
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const sessionKey = `steward-html-review-draft:${endpoint}`
  const tabStorage = memoryStorage()
  let clientSequence = 0
  const createClientId = () => `client-${++clientSequence}`
  const firstLoad = createDraftSession(tabStorage, sessionKey, createClientId, [])
  const firstComments = [{ id: 'one', comment: 'Keep this through reload' }]

  const firstSave = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: firstLoad.clientId,
      instance_id: firstLoad.instanceId,
      revision: firstLoad.nextRevision(firstComments),
      comments: firstComments,
    }),
  })
  assert.equal(firstSave.status, 200)

  const clonedStorage = memoryStorage(tabStorage.entries())
  const clonedTab = createDraftSession(clonedStorage, sessionKey, createClientId, [])
  assert.equal(clonedTab.clientId, firstLoad.clientId)
  assert.notEqual(clonedTab.instanceId, firstLoad.instanceId)
  assert.deepEqual(clonedTab.comments, firstComments)
  const clonedSave = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clonedTab.clientId,
      instance_id: clonedTab.instanceId,
      revision: clonedTab.nextRevision(clonedTab.comments),
      comments: clonedTab.comments,
    }),
  })
  assert.equal(clonedSave.status, 409)
  assert.match(await clonedSave.text(), /another browser tab owns this review draft/)

  const handoff = firstLoad.prepareHandoff(firstComments)
  const abandon = await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: firstLoad.clientId,
      instance_id: firstLoad.instanceId,
      handoff_credential: handoff.reconnectCredential,
      next_handoff_credential: handoff.handoffCredential,
      revision: handoff.revision,
      comments: firstComments,
    }),
  })
  assert.equal(abandon.status, 200)

  const clonedHeartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clonedTab.clientId,
      instance_id: clonedTab.instanceId,
      handoff_credential: clonedTab.handoffCredential,
    }),
  })
  assert.equal(clonedHeartbeat.status, 409)

  const reloaded = createDraftSession(tabStorage, sessionKey, createClientId, [])
  assert.equal(reloaded.clientId, firstLoad.clientId)
  assert.notEqual(reloaded.instanceId, firstLoad.instanceId)
  assert.equal(reloaded.revision, 2)
  assert.deepEqual(reloaded.comments, firstComments)
  assert.equal(reloaded.handoffCredential, handoff.handoffCredential)
  const reconnect = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
    }),
  })
  assert.equal(reconnect.status, 200)
  reloaded.completeHandoff(reloaded.handoffCredential)
  assert.equal(reloaded.handoffCredential, null)
  const reloadedComments = [...reloaded.comments, { id: 'two', comment: 'Added after reload' }]
  const resumedSave = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
      revision: reloaded.nextRevision(reloadedComments),
      comments: reloadedComments,
    }),
  })
  assert.equal(resumedSave.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, reloadedComments)

  const competingTab = createDraftSession(memoryStorage(), sessionKey, createClientId, [])
  const competingSave = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: competingTab.clientId,
      instance_id: competingTab.instanceId,
      handoff_credential: competingTab.handoffCredential,
      revision: competingTab.nextRevision([]),
      comments: [],
    }),
  })
  assert.equal(competingSave.status, 409)
  assert.match(await competingSave.text(), /another browser tab owns this review draft/)
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')).comments, reloadedComments)

  const rejectedSubmit = await fetch(new URL(`${endpoint}/submit`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clonedTab.clientId,
      instance_id: clonedTab.instanceId,
      handoff_credential: clonedTab.handoffCredential,
      comments: clonedTab.comments,
    }),
  })
  assert.equal(rejectedSubmit.status, 409)
  const rejectedCancel = await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: competingTab.clientId,
      instance_id: competingTab.instanceId,
      handoff_credential: competingTab.handoffCredential,
    }),
  })
  assert.equal(rejectedCancel.status, 409)

  const submit = await fetch(new URL(`${endpoint}/submit`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
      comments: reloadedComments,
    }),
  })
  assert.equal(submit.status, 200)
  assert.deepEqual(await review.completion, { action: 'submit', comments: reloadedComments })
})

test('reload handoff survives heartbeat arriving before abandon without a timed retry', async t => {
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
    tabCloseGraceMs: 1_000,
    handoffOrderingGraceMs: 1_000,
  })
  t.after(() => review.close())
  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  const sessionKey = `steward-html-review-draft:${endpoint}`
  const storage = memoryStorage()
  let sequence = 0
  const createId = () => `ordered-${++sequence}`
  const owner = createDraftSession(storage, sessionKey, createId, [])
  const comments = [{ id: 'one', comment: 'Survive reversed request ordering' }]

  const firstSave = await fetch(new URL(`${endpoint}/draft`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: owner.clientId,
      instance_id: owner.instanceId,
      handoff_credential: owner.handoffCredential,
      revision: owner.nextRevision(comments),
      comments,
    }),
  })
  assert.equal(firstSave.status, 200)

  const handoff = owner.prepareHandoff(comments)
  const reloaded = createDraftSession(storage, sessionKey, createId, [])
  const earlyHeartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
    }),
  })
  assert.equal(earlyHeartbeat.status, 202)

  const abandon = await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: owner.clientId,
      instance_id: owner.instanceId,
      handoff_credential: handoff.reconnectCredential,
      next_handoff_credential: handoff.handoffCredential,
      revision: handoff.revision,
      comments,
    }),
  })
  assert.equal(abandon.status, 200)

  const confirmedHeartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
    }),
  })
  assert.equal(confirmedHeartbeat.status, 200)
  reloaded.completeHandoff(reloaded.handoffCredential)
  assert.equal(reloaded.revision, 2)
  assert.deepEqual(reloaded.comments, comments)

  const cancel = await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: reloaded.clientId,
      instance_id: reloaded.instanceId,
      handoff_credential: reloaded.handoffCredential,
    }),
  })
  assert.equal(cancel.status, 200)
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
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
    body: JSON.stringify({
      client_id: 'review-tab',
      instance_id: 'review-page-1',
      handoff_credential: null,
      next_handoff_credential: 'handoff-1',
      revision: 1,
      comments,
    }),
  })
  assert.equal(firstClose.status, 200)
  const heartbeat = await fetch(new URL(`${endpoint}/heartbeat`, review.reviewUrl), {
    method: 'POST',
    body: JSON.stringify({ client_id: 'review-tab', instance_id: 'review-page-2', handoff_credential: 'handoff-1' }),
  })
  assert.equal(heartbeat.status, 200)
  const remainedOpen = await Promise.race([
    review.completion.then(() => false),
    new Promise(resolveWait => setTimeout(() => resolveWait(true), 40)),
  ])
  assert.equal(remainedOpen, true)

  const secondClose = await fetch(new URL(`${endpoint}/abandon`, review.reviewUrl), {
    method: 'POST',
    body: JSON.stringify({
      client_id: 'review-tab',
      instance_id: 'review-page-2',
      handoff_credential: 'handoff-1',
      next_handoff_credential: 'handoff-2',
      revision: 2,
      comments,
    }),
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
  const events = []
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

  const endpoint = new URL(review.reviewUrl).pathname.replace(/\/review$/, '')
  await fetch(new URL(`${endpoint}/cancel`, review.reviewUrl), {
    method: 'POST',
    body: JSON.stringify({ client_id: 'proxy-tab', instance_id: 'proxy-page', handoff_credential: null }),
  })
  assert.deepEqual(await review.completion, { action: 'cancel', comments: [] })
  assert.ok(events.some(event => event.message === 'Review server ready'))
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

test('an unavailable served page returns a visible error and writes a diagnostic event', async t => {
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
    body: JSON.stringify({ client_id: 'unavailable-tab', instance_id: 'unavailable-page', handoff_credential: null }),
  })
  await review.completion
})
