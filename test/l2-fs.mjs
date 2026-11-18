/**
 * L2 — WslFileSystem semantics against the real WSL distro.
 * Run: node test/l2-fs.mjs [distro]
 */
import assert from 'node:assert/strict'
import WslFileSystem from '../lib/fs.js'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'

const distro = process.argv[2] || 'Ubuntu-24.04'
let passed = 0

function ok(label) {
  passed++
  console.log(`  ✓ ${label}`)
}

async function expectCode(label, code, promise) {
  try {
    await promise
    throw new Error(`${label}: expected ${code}, got success`)
  } catch (error) {
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`)
    ok(`${label} (${code})`)
  }
}

// Stub context: the Service base registers via ctx.reflect.provide.
const stubCtx = { reflect: { provide() {} }, logger: { warn() {}, info() {} } }
const fs = new WslFileSystem(stubCtx, WslFileSystem.Config({ nodePath: 'node' }))

const UNC_ROOT = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-overlay-l2-${process.pid}`
const unc = (rest) => `${UNC_ROOT}\\${rest}`

console.log(`L2 fs tests — distro ${distro}`)

// --- resolve + stat + writeText/readText -----------------------------------
const target = await fs.resolve(unc('hello.txt'), { cwd: UNC_ROOT })
assert.match(String(target.targetKey), /^wsl:\/\/[^/]+\/tmp\//)
assert.match(target.displayPath, /^\\\\wsl\.localhost\\/)
ok(`resolve → ${target.displayPath}`)

const write = await fs.writeText(target, 'alpha\nbeta\ngamma\n')
assert.equal(write.operation, 'create')
assert.equal(write.before, null)
assert.equal(write.after, 'alpha\nbeta\ngamma\n')
assert.notEqual(write.version, undefined)
ok('writeText create (version stamped)')

const stat = await fs.stat(target)
assert.equal(stat.type, 'file')
assert.equal(stat.size, 17)
assert.equal(stat.version, write.version)
ok('stat version matches write outcome')

const read = await fs.readText(target)
assert.equal(read, 'alpha\nbeta\ngamma\n')
ok('readText round-trip')

// --- readText on absent / binary -------------------------------------------
const ghost = await fs.resolve(unc('never-created.txt'), { cwd: UNC_ROOT })
await expectCode('readText absent', 'FS_NOT_FOUND', fs.readText(ghost))
await fs.writeText(await fs.resolve(unc('bin.dat'), { cwd: UNC_ROOT }), 'x', undefined)
await fs.call('exec', { command: `printf '\\x00\\x01\\x02' > '${`/tmp/dsh-wsl-overlay-l2-${process.pid}`}/bin.dat'` })
await expectCode('readText binary', 'FS_NOT_TEXT', fs.readText(await fs.resolve(unc('bin.dat'), { cwd: UNC_ROOT })))

// --- guarded writes ----------------------------------------------------------
await expectCode('createIfAbsent on existing', 'FS_NOT_OBSERVED', fs.writeText(target, 'x', { kind: 'createIfAbsent' }))
await expectCode('stale replaceIfVersion', 'FS_STALE_VERSION', fs.writeText(target, 'x', { kind: 'replaceIfVersion', version: 'bogus' }))
const rewrite = await fs.writeText(target, 'alpha2\nbeta2\n', { kind: 'replaceIfVersion', version: write.version })
assert.equal(rewrite.operation, 'update')
assert.equal(rewrite.before, 'alpha\nbeta\ngamma\n')
ok('guarded rewrite (before basis captured)')

// --- editText: literal edit with CRLF fidelity ------------------------------
const crlfTarget = await fs.resolve(unc('crlf.txt'), { cwd: UNC_ROOT })
await fs.writeText(crlfTarget, 'one\r\ntwo\r\nthree\r\n')
const edited = await fs.editText(crlfTarget, { oldString: 'two', newString: 'TWO-EDITED', replaceAll: false })
assert.equal(edited.before, 'one\ntwo\nthree\n')
assert.equal(edited.after, 'one\nTWO-EDITED\nthree\n')
const crlfOnDisk = await fs.readText(crlfTarget)
assert.equal(crlfOnDisk, 'one\r\nTWO-EDITED\r\nthree\r\n', 'CRLF bytes preserved on disk')
ok('editText literal edit, CRLF byte fidelity')

await expectCode('edit not found', 'FS_EDIT_NOT_FOUND', fs.editText(crlfTarget, { oldString: 'nope', newString: 'x', replaceAll: false }))
const amb = await fs.editText(crlfTarget, { oldString: 'e', newString: 'E', replaceAll: false }).catch((e) => e)
assert.equal(amb.code, 'FS_AMBIGUOUS_EDIT', `expected ambiguity, got ${amb.code}: ${amb.message}`)
const all = await fs.editText(crlfTarget, { oldString: 'e', newString: 'E', replaceAll: true })
assert.equal(all.after, 'onE\nTWO-EDITED\nthrEE\n')
ok('editText guards + replaceAll')

// --- patchText ---------------------------------------------------------------
const patchTarget = await fs.resolve(unc('patched.txt'), { cwd: UNC_ROOT })
await fs.writeText(patchTarget, 'l1\nl2\nl3\nl4\n')
const patch = parsePatch(
  ['*** Begin Patch', '*** Update File: patched.txt', '@@', ' l2', '-l3', '+L3-EDITED', ' l4', '*** End Patch'].join('\n'),
)[0].hunks
const patchResult = await fs.patchText(patchTarget, patch)
assert.equal(patchResult.after, 'l1\nl2\nL3-EDITED\nl4\n')
ok('patchText via official applyHunks')

// --- listDir + lstat ----------------------------------------------------------
await fs.writeText(await fs.resolve(unc('dir/inner.txt'), { cwd: UNC_ROOT }), 'i')
const entries = await fs.listDir(await fs.resolve(UNC_ROOT, { cwd: UNC_ROOT }))
assert.ok(entries.length >= 5)
assert.ok(entries.some((e) => e.name === 'hello.txt' && e.type === 'file'))
assert.ok(entries.some((e) => e.name === 'dir' && e.type === 'directory'))
ok(`listDir (${entries.length} entries)`)

await fs.call('exec', { command: `ln -sf hello.txt '/tmp/dsh-wsl-overlay-l2-${process.pid}/l2-link'` })
const pathInfo = await fs.lstat(unc('l2-link'), { cwd: UNC_ROOT })
assert.equal(pathInfo.type, 'symlink')
ok('lstat symlink typing')

// --- readBytes / readByteRange / streamText ----------------------------------
const bytes = await fs.readBytes(await fs.resolve(unc('bin.dat'), { cwd: UNC_ROOT }), undefined, 1024)
assert.equal(bytes.length, 3)
await expectCode('readBytes over cap', 'FS_TOO_LARGE', fs.readBytes(await fs.resolve(unc('bin.dat'), { cwd: UNC_ROOT }), undefined, 2))
const window = await fs.readByteRange(target, { offset: 0, length: 6 })
assert.equal(Buffer.from(window).toString('utf8'), 'alpha2')
ok('readBytes + readByteRange')

const streamed = []
for await (const chunk of await fs.streamText(target, undefined)) streamed.push(chunk)
assert.equal(streamed.join(''), 'alpha2\nbeta2\n')
ok('streamText')

// --- moveFile -----------------------------------------------------------------
const moveFrom = await fs.resolve(unc('moveme.txt'), { cwd: UNC_ROOT })
await fs.writeText(moveFrom, 'moving\n')
const moveTo = await fs.resolve(unc('moved.txt'), { cwd: UNC_ROOT })
const move = await fs.moveFile(moveFrom, moveTo, {})
assert.equal(move.sourceDeleted, true)
assert.equal(move.destination.after, 'moving\n')
await expectCode('move source gone', 'FS_NOT_FOUND', fs.readText(moveFrom))
const movedRead = await fs.readText(moveTo)
assert.equal(movedRead, 'moving\n')
ok('moveFile publish-then-remove')

// --- deleteFile + fence --------------------------------------------------------
const del = await fs.deleteFile(await fs.resolve(unc('moved.txt'), { cwd: UNC_ROOT }), undefined)
assert.equal(del.before, 'moving\n')
ok('deleteFile with basis')

await fs.call('exec', { command: `mkdir -p '/tmp/dsh-wsl-overlay-l2-${process.pid}/fence' && printf inside > '/tmp/dsh-wsl-overlay-l2-${process.pid}/fence/in.txt'` })
const fenceTarget = await fs.resolve(unc('fence/in.txt'), { cwd: UNC_ROOT })
const workspacePolicy = { mode: 'workspace-write', workspaceRoot: UNC_ROOT, additionalWritableRoots: [] }
const insideWrite = await fs.writeText(fenceTarget, 'edited-inside\n', undefined, undefined, workspacePolicy)
assert.equal(insideWrite.operation, 'update')
ok('fence allows workspace-root writes')

const outsideTarget = await fs.resolve('\\\\wsl.localhost\\' + distro + '\\home\\dsh-wsl-overlay-fence-test.txt', { cwd: UNC_ROOT })
await expectCode('fence denies outside root', 'FS_SANDBOX_DENIED', fs.writeText(outsideTarget, 'x\n', undefined, undefined, workspacePolicy))
const roPolicy = { mode: 'read-only', workspaceRoot: UNC_ROOT, additionalWritableRoots: [] }
await expectCode('fence denies read-only', 'FS_SANDBOX_DENIED', fs.writeText(fenceTarget, 'x\n', undefined, undefined, roPolicy))
const mntPolicy = { mode: 'workspace-write', workspaceRoot: '\\\\wsl.localhost\\' + distro + '\\mnt\\g', additionalWritableRoots: [] }
await expectCode('fence denies /mnt root for /home target', 'FS_SANDBOX_DENIED', fs.writeText(fenceTarget, 'x\n', undefined, undefined, mntPolicy))
ok('fence read-only + /mnt-mismatch denials')

// --- sandboxMode stays undefined ------------------------------------------------
assert.equal(fs.sandboxMode, undefined)
ok('sandboxMode undefined (WSL VM is the boundary)')

console.log(`\nL2 PASS — ${passed} checks`)
process.exit(0)
