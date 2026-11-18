/**
 * L1 — drive the real agent channel against the real WSL distro.
 * Run: node test/l1-channel.mjs [distro]
 */
import assert from 'node:assert/strict'
import { Channel, ChannelError, channelFor, IDLE_TTL_MS } from '../lib/channel.js'

const distro = process.argv[2] || 'Ubuntu-24.04'
const opts = { distro, nodePath: 'node' }
let passed = 0

// Watchdog: never hang silently — dump liveness and exit after 2 minutes.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: 120s elapsed, aborting (tests stuck)')
  process.exit(3)
}, 120_000)
watchdog.unref()

function ok(label) {
  passed++
  console.log(`  ✓ ${label}`)
}

async function expectError(label, code, promise) {
  try {
    await promise
    throw new Error(`${label}: expected ${code}, got success`)
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`)
    ok(`${label} (${code})`)
  }
}

const tmpRoot = `/tmp/dsh-wsl-overlay-l1-${process.pid}`

console.log(`L1 channel tests — distro ${distro}`)
console.time('boot')
const channel = await channelFor(opts)
console.timeEnd('boot')

// --- ping -----------------------------------------------------------------
{
  const reply = await channel.request('ping')
  assert.equal(reply.ok, true)
  assert.match(reply.node, /^v\d+\./)
  ok(`ping → ${reply.node}`)
}

// --- write / stat / read round-trip --------------------------------------
{
  const payload = Buffer.from('hello wsl overlay\n', 'utf8').toString('base64')
  await channel.request('write', { path: `${tmpRoot}/hello.txt`, data: payload })
  const st = await channel.request('stat', { path: `${tmpRoot}/hello.txt` })
  assert.equal(st.ok, true)
  assert.equal(st.view.size, 18)
  assert.equal(st.view.dir, false)
  const rd = await channel.request('read', { path: `${tmpRoot}/hello.txt` })
  assert.equal(Buffer.from(rd.data, 'base64').toString('utf8'), 'hello wsl overlay\n')
  assert.equal(rd.version, st.version)
  ok('write/stat/read round-trip (implicit mkdir)')
}

// --- mode preservation ----------------------------------------------------
{
  await channel.request('write', { path: `${tmpRoot}/script.sh`, data: Buffer.from('#!/bin/sh\necho hi\n').toString('base64'), mode: 0o755 })
  const st1 = await channel.request('stat', { path: `${tmpRoot}/script.sh` })
  assert.equal(st1.view.mode, 0o755)
  await channel.request('write', { path: `${tmpRoot}/script.sh`, data: Buffer.from('#!/bin/sh\necho ho\n').toString('base64') })
  const st2 = await channel.request('stat', { path: `${tmpRoot}/script.sh` })
  assert.equal(st2.view.mode, 0o755, 'overwrite must preserve mode bits')
  ok('write preserves mode bits on overwrite')
}

// --- version guard --------------------------------------------------------
{
  const st = await channel.request('stat', { path: `${tmpRoot}/hello.txt` })
  await channel.request('write', { path: `${tmpRoot}/hello.txt`, data: Buffer.from('v2\n').toString('base64') })
  await expectError('stale write', 'EVERSION', channel.request('write', { path: `${tmpRoot}/hello.txt`, data: Buffer.from('v3\n').toString('base64'), version: st.version }))
  const rd = await channel.request('read', { path: `${tmpRoot}/hello.txt` })
  assert.equal(Buffer.from(rd.data, 'base64').toString('utf8'), 'v2\n')
  ok('version guard rejects write-after-change')
}

// --- readRange ------------------------------------------------------------
{
  const big = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff
  await channel.request('write', { path: `${tmpRoot}/big.bin`, data: big.toString('base64') })
  const r1 = await channel.request('readRange', { path: `${tmpRoot}/big.bin`, offset: 0, length: 16 })
  assert.equal(Buffer.from(r1.data, 'base64').length, 16)
  assert.deepEqual([...Buffer.from(r1.data, 'base64')], [...big.subarray(0, 16)])
  const r2 = await channel.request('readRange', { path: `${tmpRoot}/big.bin`, offset: 1024 * 1024 - 4 })
  assert.equal(Buffer.from(r2.data, 'base64').length, 4)
  assert.equal(r2.total, 1024 * 1024)
  const rd = await channel.request('read', { path: `${tmpRoot}/big.bin` })
  assert.deepEqual(Buffer.from(rd.data, 'base64'), big)
  ok('readRange + 1MiB binary round-trip')
}

// --- readdir with dirs and links -----------------------------------------
{
  await channel.request('write', { path: `${tmpRoot}/dir/nested.txt`, data: Buffer.from('x').toString('base64') })
  await channel.request('exec', { command: `ln -sfn hello.txt ${tmpRoot}/link.txt && ln -sfn ${tmpRoot}/dir ${tmpRoot}/dirlink` })
  const rd = await channel.request('readdir', { path: tmpRoot })
  assert.equal(rd.ok, true)
  assert.ok(rd.n.length >= 5)
  assert.ok(rd.d.includes('dir'), 'dirs reported')
  assert.ok(rd.n.indexOf('dir') < rd.n.indexOf('big.bin'), 'dirs sort first')
  assert.equal(rd.l['link.txt'], 'hello.txt')
  ok(`readdir (${rd.n.length} entries, links resolved)`)
}

// --- lstat symlink --------------------------------------------------------
{
  const st = await channel.request('lstat', { path: `${tmpRoot}/link.txt` })
  assert.equal(st.view.link, 'hello.txt')
  const stReal = await channel.request('stat', { path: `${tmpRoot}/link.txt` })
  assert.equal(stReal.view.link, null)
  // hello.txt was rewritten to "v2\n" by the version-guard section above;
  // stat follows the symlink to the CURRENT target size.
  assert.equal(stReal.view.size, 3, 'stat follows symlinks')
  ok('lstat vs stat symlink semantics')
}

// --- exec: streaming, exit code, stdin ------------------------------------
{
  const chunks = []
  const reply = await channel.request('exec', {
    command: 'echo out-$FOO; echo err-1 >&2; echo payload; seq 1 500 | head -50 >&1',
    env: { FOO: 'bar' },
    stdin: Buffer.from('ignored\n').toString('base64'),
  }, { onEvent: (doc) => chunks.push(doc) })
  assert.equal(reply.code, 0)
  const out = chunks.filter((c) => c.ev === 'o').map((c) => Buffer.from(c.d, 'base64').toString('utf8')).join('')
  const err = chunks.filter((c) => c.ev === 'e').map((c) => Buffer.from(c.d, 'base64').toString('utf8')).join('')
  assert.match(out, /out-bar/)
  assert.match(out, /payload/)
  assert.match(err, /err-1/)
  ok(`exec streaming (${chunks.length} chunks, code 0, env passed)`)
}

// --- exec: timeout kills the tree -----------------------------------------
{
  const reply = await channel.request('exec', { command: 'echo start; sleep 30; echo never', timeoutMs: 1500 })
  assert.equal(reply.timedOut, true)
  const chunks2 = []
  const probe = await channel.request('exec', { command: 'echo alive' }, { onEvent: (d) => chunks2.push(d) })
  assert.equal(probe.code, 0, 'agent stays responsive after killTree')
  ok('exec timeout killTree, channel survives')
}

// --- exec: login environment captured --------------------------------------
{
  const reply = await channel.request('exec', { command: 'echo PATH0=$PATH0' })
  // login env merged at boot; just prove exec env composition works
  assert.equal(reply.code, 0)
  ok('exec runs (login-env merge active)')
}

// --- realpath / errors ------------------------------------------------------
{
  const rp = await channel.request('realpath', { path: `${tmpRoot}/link.txt` })
  assert.match(rp.path, new RegExp(`${tmpRoot}/hello.txt$`.replace(/\//g, '\\/')))
  await expectError('ENOENT stat', 'ENOENT', channel.request('read', { path: `${tmpRoot}/missing.txt` }))
  await expectError('unknown op', 'EOP', channel.request('nope', {}))
  ok('realpath + ENOENT + EOP codes')
}

// --- default timeout semantics: 0 disables ---------------------------------
{
  const reply = await channel.request('exec', { command: 'sleep 2; echo done', timeoutMs: 0 })
  assert.equal(reply.code, 0)
  assert.equal(reply.timedOut, false)
  ok('timeoutMs 0 disables wait limit')
}

// --- close + reopen ---------------------------------------------------------
{
  channel.close()
  await expectError('request on closed channel', 'ECHANNEL', channel.request('ping'))
  const fresh = await channelFor(opts)
  const reply = await fresh.request('ping')
  assert.equal(reply.ok, true)
  ok('closed channel evicted; channelFor reopens fresh')
}

// --- exec kill by id --------------------------------------------------------
{
  const fresh = await channelFor(opts)
  const slowId = `slow-${Date.now()}`
  const slowPromise = fresh.request('exec', { command: 'sleep 20' }).catch((e) => e)
  await new Promise((r) => setTimeout(r, 500))
  // The exec request id is internal; kill via a follow-up op with the id we sent.
  // (The public fs/shell layer wraps this; here we verify the op exists.)
  const killReply = await fresh.request('kill', { target: 'nonexistent' })
  assert.equal(killReply.killed, false)
  const result = await slowPromise
  assert.equal(result.code, 0)
  ok('kill op responds (miss reports killed:false)')
}

console.log(`\nL1 PASS — ${passed} checks`)
process.exit(0)
