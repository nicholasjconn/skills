import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReviewServer, parseArgs, parseSource } from '../scripts/html_review.mjs'

const origin = 'https://review.example-tailnet.ts.net:9443'
const authority = new URL(origin).host
const helper = fileURLToPath(new URL('../scripts/tailscale_serve.mjs', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Retain diagnostic fixtures; callers can put TMPDIR in their scratch tree.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tailscale-review-test-'))
  const html = join(directory, 'page.html')
  writeFileSync(html, '<html><body><h1 id="heading">Review</h1></body></html>')
  return { directory, html }
}

function raw(port, path, headers = [], body = '', method = 'GET', upgrade = false) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${method} ${path} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${upgrade ? '' : 'Connection: close\r\n'}\r\n${body}`)
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      response += chunk
      if (upgrade && response.includes('\r\n\r\n')) { socket.destroy(); resolve(response) }
    })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}
const status = response => Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])

async function review(t, source, directory) {
  const server = await createReviewServer({
    source, publicOrigin: origin, draftOutput: join(directory, 'draft.json'),
    initialComments: [], overlayScript: 'const endpoint=__ENDPOINT__; const comments=__INITIAL_COMMENTS__;', log: () => {},
  })
  t.after(() => server.close())
  return server
}

test('Tailscale CLI flags keep local and HTTPS ports separate and reject mixed exposure modes', () => {
  const { html } = fixture()
  const args = parseArgs([html, '--tailscale', '--port', '12345', '--tailscale-port', '9443'])
  assert.equal(args.tailscale, true)
  assert.equal(args.port, 12345)
  assert.equal(args.tailscale_port, 9443)
  assert.throws(() => parseArgs([html, '--tailscale-port', '9443']), /requires --tailscale/)
  assert.throws(() => parseArgs([html, '--tailscale', '--tailscale-port', '0']), /integer/)
  assert.throws(() => parseArgs([html, '--tailscale', '--tls-cert', html, '--tls-key', html]), /cannot be combined/)
})

test('private review accepts only its exact configured Host and HTTPS Origin', async t => {
  const { directory, html } = fixture()
  const server = await review(t, parseSource(html), directory)
  assert.equal(server.reviewUrl, `${origin}/page.html`)
  const page = await raw(server.localPort, '/page.html', [['Host', authority]])
  assert.equal(status(page), 200)
  assert.match(page, /id="heading"/)
  assert.match(page, new RegExp(server.endpoint))
  assert.equal(status(await raw(server.localPort, '/page.html', [['Host', `127.0.0.1:${server.localPort}`]])), 403)
  assert.equal(status(await raw(server.localPort, '/page.html', [['Host', authority], ['Host', authority]])), 403)
  for (const invalid of [origin.replace('https:', 'http:'), origin.replace('9443', '9444'), 'https://another.ts.net:9443', `${origin}/path`, 'null']) {
    assert.equal(status(await raw(server.localPort, `${server.endpoint}/draft`, [['Host', authority], ['Origin', invalid]], '{"comments":[]}', 'POST')), 403)
  }
  assert.equal(status(await raw(server.localPort, `${server.endpoint}/draft`, [['Host', authority], ['Origin', origin], ['Origin', origin]], '{"comments":[]}', 'POST')), 403)
  const comments = [{ id: 'public-comment', comment: 'Change this heading', selector: '#heading', iframe_path: ['#frame'] }]
  assert.equal(status(await raw(server.localPort, `${server.endpoint}/draft`, [['Host', authority], ['Origin', origin]], JSON.stringify({ comments }), 'POST')), 200)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'draft.json'))).comments, comments)
  assert.equal(status(await raw(server.localPort, `${server.endpoint}/submit`, [['Host', authority], ['Origin', origin]], '{}', 'POST')), 200)
  assert.deepEqual(await server.completion, { action: 'submit', comments })
})

test('private loopback proxy preserves API requests and WebSocket upgrades without trusting forwarding identity', async t => {
  const { directory } = fixture()
  const upstream = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { response.end(JSON.stringify({ method: request.method, url: request.url, body, headers: request.headers })) })
  })
  let upgradeHeaders
  upstream.on('upgrade', (request, socket) => {
    upgradeHeaders = request.headers
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const localOrigin = `http://127.0.0.1:${upstream.address().port}`
  const server = await review(t, parseSource(`${localOrigin}/page?q=1`), directory)
  const headers = [['Host', authority], ['Origin', origin], ['Forwarded', 'for=spoofed'], ['X-Forwarded-Host', 'spoofed'], ['Tailscale-User-Login', 'spoofed']]
  const response = await raw(server.localPort, '/api?q=2', headers, 'request body', 'POST')
  assert.equal(status(response), 200)
  const payload = JSON.parse(response.split('\r\n\r\n')[1])
  assert.equal(payload.method, 'POST')
  assert.equal(payload.url, '/api?q=2')
  assert.equal(payload.body, 'request body')
  assert.equal(payload.headers.origin, localOrigin)
  assert.equal(payload.headers.host, new URL(localOrigin).host)
  for (const header of ['forwarded', 'x-forwarded-host', 'tailscale-user-login']) assert.equal(payload.headers[header], undefined)
  const wsHeaders = [...headers, ['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Key', 'dGVzdA=='], ['Sec-WebSocket-Version', '13']]
  assert.equal(status(await raw(server.localPort, '/socket', wsHeaders, '', 'GET', true)), 101)
  assert.equal(upgradeHeaders.origin, localOrigin)
  assert.equal(upgradeHeaders['tailscale-user-login'], undefined)
  assert.equal(status(await raw(server.localPort, '/socket', wsHeaders.map(([k, v]) => [k, k === 'Origin' ? origin.replace('https:', 'http:') : v]), '', 'GET', true)), 403)
})

function fakeTailscale(directory, configuration, wrapped = false) {
  const executable = join(directory, 'tailscale')
  writeFileSync(join(directory, 'configuration.json'), JSON.stringify(configuration))
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst dir = path.dirname(__filename);\nconst args = process.argv.slice(2);\nfs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify(args)+'\\n');\nconst config = JSON.parse(fs.readFileSync(path.join(dir,'configuration.json')));\nif (args[0] === 'status') console.log(JSON.stringify(config.status));\nelse if(args[1] === 'status') console.log(JSON.stringify(config.serve));\nelse {\n if(config.failServe) { console.error('deliberate Serve failure'); process.exit(37) }\n fs.writeFileSync(path.join(dir,'started'), String(process.pid));\n process.on('SIGINT', () => { fs.writeFileSync(path.join(dir,'stopped'), 'SIGINT'); process.exit(0) });\n setInterval(() => {}, 1000);\n}\n`, { mode: 0o755 })
  if (wrapped) {
    writeFileSync(join(directory, 'tailscale-node'), readFileSync(executable), { mode: 0o755 })
    writeFileSync(executable, '#!/bin/sh\n"$(dirname "$0")/tailscale-node" "$@"\n', { mode: 0o755 })
  }
  return { ...process.env, PATH: `${directory}:${process.env.PATH}` }
}
const connected = { BackendState: 'Running', Self: { DNSName: 'review.example-tailnet.ts.net.' }, CertDomains: ['review.example-tailnet.ts.net'] }
function prepareWith(env, port) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {prepareTailscaleServe} from ${JSON.stringify(new URL('../scripts/tailscale_serve.mjs', import.meta.url).href)}; try { console.log(JSON.stringify(await prepareTailscaleServe(${JSON.stringify(port ?? null)}))) } catch(e) { console.error(e.message); process.exitCode=1 }`], { env, encoding: 'utf8' })
}

test('Serve preflight discovers names, avoids persistent and foreground ports, and fails on prerequisites', () => {
  const { directory } = fixture()
  let env = fakeTailscale(directory, { status: connected, serve: { TCP: { 443: {} }, Foreground: { existing: { TCP: { 8443: {} } } } } })
  let result = prepareWith(env)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { port: 8444, origin: 'https://review.example-tailnet.ts.net:8444' })
  result = prepareWith(env, 443)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /occupied/)
  env = fakeTailscale(directory, { status: { ...connected, BackendState: 'NeedsLogin' }, serve: {} })
  assert.match(prepareWith(env).stderr, /must be connected/)
  env = fakeTailscale(directory, { status: { ...connected, CertDomains: [] }, serve: {} })
  assert.match(prepareWith(env).stderr, /Enable HTTPS/)
  env = fakeTailscale(directory, { status: { ...connected, Self: { DNSName: 'invalid' } }, serve: {} })
  assert.match(prepareWith(env).stderr, /valid device DNS name/)
  assert.match(prepareWith({ ...env, PATH: join(directory, 'missing') }).stderr, /CLI on PATH/)
  const commands = readFileSync(join(directory, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(commands.every(command => ['status', 'serve'].includes(command[0]) && (command[0] === 'status' || command[1] === 'status')))
})

test('loss of worker IPC stops only the owned foreground Serve process', async t => {
  const { directory } = fixture()
  const env = fakeTailscale(directory, { status: connected, serve: {} }, true)
  const guardian = spawn(process.execPath, [helper, '--session', '9443', '12345'], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const closed = new Promise(resolve => guardian.once('exit', resolve))
  t.after(() => { if (guardian.exitCode === null) guardian.kill('SIGTERM') })
  const waitFor = async name => {
    for (let n = 0; n < 100; n++) {
      try { return readFileSync(join(directory, name), 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
      await pause(20)
    }
    throw new Error(`guardian did not produce ${name}`)
  }
  await waitFor('started')
  guardian.disconnect()
  assert.equal(await closed, 0)
  assert.equal(await waitFor('stopped'), 'SIGINT')
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'commands.jsonl'), 'utf8')), ['serve', '--bg=false', '--https=9443', 'http://127.0.0.1:12345'])
})


test('async Serve startup failures return an error without advertising a local fallback', () => {
  const { directory, html } = fixture()
  const env = fakeTailscale(directory, { status: connected, serve: {}, failServe: true })
  const output = join(directory, 'feedback.json')
  const script = fileURLToPath(new URL('../scripts/html_review.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, html, '--tailscale', '--async', '--no-open', '--output', output], { env, encoding: 'utf8', timeout: 6000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /Review URL:|Review server started/)
  assert.match(result.stderr, /Could not start the asynchronous review/)
  assert.match(readFileSync(join(directory, 'feedback.log'), 'utf8'), /deliberate Serve failure/)
})
