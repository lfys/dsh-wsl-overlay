/**
 * L2 — WslShellExecutor: workdir mapping, WSLENV composition, argv shape,
 * deadline classification — through a minimal faithful fake of the
 * subprocess service, plus one real wsl.exe round-trip.
 * Run: node test/l2-shell.mjs [distro]
 */
import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import WslShellExecutor from '../lib/shell.js'

const distro = process.argv[2] || 'Ubuntu-24.04'
let passed = 0
const ok = (label) => {
  passed++
  console.log(`  ✓ ${label}`)
}

console.log(`L2 shell tests — distro ${distro}`)

/** Minimal faithful fake of ctx.subprocess.spawn: runs the argv for real and
 *  exposes the collect readers + done/terminate contract surface. */
function makeSubprocess() {
  const spawned = []
  const service = {
    spawned,
    spawn(spec) {
      const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
      })
      if (spec.signal) {
        spec.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGTERM')
            setTimeout(() => {
              try {
                child.kill('SIGKILL')
              } catch {}
            }, 300)
          },
          { once: true },
        )
      }
      spawned.push(spec)
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      child.stdout.on('data', (d) => (stdout = Buffer.concat([stdout, d])))
      child.stderr.on('data', (d) => (stderr = Buffer.concat([stderr, d])))
      if (spec.stdio?.stdin?.data) child.stdin.write(spec.stdio.stdin.data)
      child.stdin.end()
      const reader = (buf) => ({
        readFrom: (offset) => ({
          text: buf.toString('utf8').slice(offset),
          lossy: false,
          nextOffset: buf.toString('utf8').length,
        }),
      })
      const handle = {
        collected: {
          stdout: reader(stdout),
          stderr: reader(stderr),
        },
        terminated: false,
        terminate() {
          this.terminated = true
          child.kill()
        },
        done: new Promise((resolve) => {
          child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
        }),
      }
      // stdout/stderr buffers are captured by closure over the live buffers
      handle.collected.stdout = {
        readFrom: (offset) => {
          const text = stdout.toString('utf8')
          return { text: text.slice(offset), lossy: false, nextOffset: text.length }
        },
      }
      handle.collected.stderr = {
        readFrom: (offset) => {
          const text = stderr.toString('utf8')
          return { text: text.slice(offset), lossy: false, nextOffset: text.length }
        },
      }
      return handle
    },
  }
  return service
}

const stubCtx = {
  reflect: { provide() {} },
  subprocess: makeSubprocess(),
}
const shell = new WslShellExecutor(stubCtx, WslShellExecutor.Config({ distro }))

// --- resolve defaults -------------------------------------------------------
const spec = shell.resolve({ command: 'echo hi' })
assert.equal(spec.timeoutMs, 120_000)
assert.equal(spec.onExpiry, 'kill')
assert.equal(spec.stdoutMaxBytes, 64_000)
ok('resolve fills defaults (timeout/policy/caps)')

// --- UNC workdir maps to --cd + distro ---------------------------------------
const proc1 = await shell.execute(
  shell.resolve({
    command: 'pwd && echo WSLENV=$WSLENV && echo TERM=$TERM && cat',
    workdir: `\\\\wsl.localhost\\${distro}\\tmp`,
    stdin: 'stdin-works\n',
    env: { MYVAR: 'passed-through' },
  }),
)
const result1 = await proc1.result()
assert.equal(result1.exitCode, 0)
assert.match(result1.stdout.text, /\/tmp\n/)
assert.match(result1.stdout.text, /stdin-works/)
assert.match(result1.stdout.text, /TERM=dumb/)
assert.ok(stubCtx.subprocess.spawned[0].env.WSLENV.includes('MYVAR'), 'WSLENV lists forwarded vars')
assert.ok(stubCtx.subprocess.spawned[0].env.WSLENV.includes('NO_COLOR'), 'WSLENV lists model-friendly overrides')
assert.equal(stubCtx.subprocess.spawned[0].env.MYVAR, 'passed-through')
ok('UNC workdir → --cd /tmp; stdin, env and WSLENV forwarding live')

// --- drive workdir maps to /mnt ----------------------------------------------
const proc2 = await shell.execute(shell.resolve({ command: 'pwd', workdir: 'G:\\Code' }))
const result2 = await proc2.result()
assert.equal(result2.exitCode, 0)
assert.match(result2.stdout.text.trim(), /\/mnt\/g\/Code/)
ok('drive workdir → /mnt/g/Code')

// --- unmappable workdir: no --cd, still runs ---------------------------------
const proc3 = await shell.execute(shell.resolve({ command: 'echo alive' }))
const result3 = await proc3.result()
assert.equal(result3.exitCode, 0)
assert.equal(result3.timedOut, false)
assert.equal(result3.aborted, false)
ok('unmapped workdir runs without --cd')

// --- non-WSL cwd passes through untouched -------------------------------------
const proc4 = await shell.execute(shell.resolve({ command: 'echo x', workdir: '\\\\some\\server\\share' }))
const argv4 = stubCtx.subprocess.spawned.at(-1).argv
assert.equal(argv4[0], 'wsl.exe') // UNC parse fails only for wsl$ names — this one is wsl.localhost-absent
// \some\server\share is NOT a wsl UNC → no distro named; executor still runs wsl (fallback)
assert.ok(!argv4.includes('--cd'))
ok('non-WSL UNC workdir → no --cd (fallback start)')

// --- deadline: timeout classifies timedOut ------------------------------------
const short = shell.resolve({ command: 'sleep 5; echo late', timeoutMs: 1200, workdir: `\\\\wsl.localhost\\${distro}\\tmp` })
const proc5 = await shell.execute(short)
const t0 = Date.now()
const result5 = await proc5.result()
const elapsed = Date.now() - t0
assert.equal(result5.timedOut, true)
assert.ok(elapsed < 4000, `timeout kill took ${elapsed}ms`)
assert.equal(proc5.status, 'killed')
ok(`timeout kills via subprocess deadline (${elapsed}ms)`)

// --- kill() on a running background proc --------------------------------------
const bg = await shell.execute(shell.resolve({ command: 'sleep 20', onExpiry: 'none' }))
await new Promise((r) => setTimeout(r, 400))
assert.equal(bg.kill(), true)
assert.equal(bg.kill(), false, 'second kill is a no-op')
assert.equal(bg.status, 'killed')
ok('background kill idempotent')

console.log(`\nL2 shell PASS — ${passed} checks`)
process.exit(0)
