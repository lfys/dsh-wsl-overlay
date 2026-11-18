#!/usr/bin/env node
/**
 * dsh-wsl-overlay agent — the half that lives INSIDE the WSL distro.
 *
 * Launched by the host as:
 *   wsl.exe -d <distro> --exec <nodePath> /mnt/<drive>/.../agent/agent.mjs
 *
 * Protocol over stdio, one JSON document per line:
 *   request          { id, op, ...params }
 *   success reply    { id, ok: true, ...payload }
 *   failure reply    { id, ok: false, code, message }
 *   exec stream      { id, ev: 'o' | 'e', d: <base64 chunk> }
 *
 * `wsl.exe --exec` bypasses login shells, so the login environment (PATH
 * additions from ~/.profile, nvm, …) is captured once at boot via
 * `bash -lc 'env -0'` and merged under process.env before any op runs.
 * Diagnostics go to stderr; the host discards them. Malformed input lines
 * are dropped silently — there is nothing sane to reply to them.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

const MAX_LINE = 96 * 1024 * 1024 // matches the host-side framing cap
const ENV_CAP = 1024 * 1024
const CHUNK_MAX = 64 * 1024 // base64-free exec bytes per streamed chunk
const MODE_MASK = 0o7777

// A dying agent must never take the channel down with a cryptic stdout
// artifact: log to stderr (which the host discards) and keep serving.
process.on('uncaughtException', (error) => {
  process.stderr.write(`agent uncaughtException: ${error?.stack || error}\n`)
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`agent unhandledRejection: ${reason?.stack || reason}\n`)
})

// ---------------------------------------------------------------------------
// Login environment capture
// ---------------------------------------------------------------------------

function captureLoginEnv() {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    let buf = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => {
      if (buf.length < ENV_CAP) buf = Buffer.concat([buf, chunk])
      if (buf.length >= ENV_CAP) child.kill()
    })
    child.on('error', () => resolve({}))
    child.on('close', () => {
      const env = {}
      for (const entry of buf.toString('utf8').split('\0')) {
        const eq = entry.indexOf('=')
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
      }
      resolve(env)
    })
  })
}

const loginEnv = await captureLoginEnv()
for (const [k, v] of Object.entries(loginEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statView(st, link = null) {
  if (!st) return null
  return {
    mode: st.mode & MODE_MASK,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ino: st.ino,
    ctimeMs: st.ctimeMs,
    dir: st.isDirectory(),
    type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    link,
  }
}

function versionOf(view) {
  if (!view) return 'absent'
  return `${view.ino}:${view.size}:${view.mtimeMs}:${view.ctimeMs}`
}

function errnoCode(error) {
  return error && typeof error.code === 'string' ? error.code : 'EIO'
}

/** stat that returns null instead of throwing — node 18's promises API
 *  ignores `throwIfNoEntry: false`, so the guard lives here. */
async function statOrNull(fn, path, link = null) {
  try {
    const st = await fn(path)
    if (!st) return null
    return link === undefined ? statView(st) : statView(st, link)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const quietStat = (path) => statOrNull((p) => fsp.stat(p), path)
const quietLstat = (path) => statOrNull((p) => fsp.lstat(p), path, undefined)

async function lstatView(path) {
  try {
    const st = await fsp.lstat(path)
    if (!st) return null
    let link = null
    if (st.isSymbolicLink()) {
      try {
        link = await fsp.readlink(path)
      } catch {}
    }
    const view = statView(st, link)
    if (st.isSymbolicLink()) view.type = 'symlink'
    return view
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Write a line to stdout, honoring backpressure so huge reads don't balloon. */
function writeLine(doc) {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(JSON.stringify(doc) + '\n', (err) => (err ? reject(err) : resolve()))
    if (!ok) process.stdout.once('drain', () => {}) // callback above still fires
  })
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

const ops = {
  async ping() {
    return { node: process.version }
  },

  async realpath({ path }) {
    return { path: await fsp.realpath(path) }
  },

  async stat({ path }) {
    const view = await quietStat(path)
    return { view, version: versionOf(view) }
  },

  async lstat({ path }) {
    const view = await lstatView(path)
    return { view, version: versionOf(view) }
  },

  async readdir({ path }) {
    const entries = await fsp.readdir(path, { withFileTypes: true })
    const dirs = []
    const files = []
    const links = {}
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        try {
          links[entry.name] = await fsp.readlink(`${path}/${entry.name}`)
        } catch {
          links[entry.name] = true
        }
      }
      if (entry.isDirectory()) dirs.push(entry.name)
      else files.push(entry.name)
    }
    dirs.sort()
    files.sort()
    return { n: [...dirs, ...files], d: dirs, l: links }
  },

  async read({ path }) {
    const view = await quietStat(path)
    if (!view) throw coded('ENOENT', `no such file: ${path}`)
    const data = await fsp.readFile(path)
    return { data: data.toString('base64'), version: versionOf(view) }
  },

  async readRange({ path, offset = 0, length }) {
    const fh = await fsp.open(path, 'r')
    try {
      const size = (await fh.stat()).size
      const want = length === undefined || length === null ? size - offset : length
      const buf = Buffer.alloc(Math.max(0, Math.min(want, size - offset)))
      if (buf.length > 0) await fh.read(buf, 0, buf.length, offset)
      return { data: buf.toString('base64'), total: size }
    } finally {
      await fh.close()
    }
  },

  /**
   * Atomic write: temp file in the target directory + rename, preserving the
   * existing file's mode bits. Implicitly creates parent directories. With
   * `version` the write is guarded: it fails EVERSION when the file on disk
   * no longer carries the version the caller read.
   */
  async write({ path, data, mode, version }) {
    if (version !== undefined && version !== null) {
      const view = await quietStat(path)
      if (versionOf(view) !== version) {
        throw coded('EVERSION', 'file changed since it was read')
      }
    }
    let writeMode = mode
    if (writeMode === undefined || writeMode === null) {
      const view = await quietLstat(path)
      writeMode = view ? view.mode : 0o644
    }
    await fsp.mkdir(path.replace(/\/[^/]*$/, '') || '/', { recursive: true })
    const tmp = `${path}.dsh-wsl-overlay-tmp-${process.pid}-${Date.now()}`
    try {
      const buf = Buffer.from(data, 'base64')
      const fh = await fsp.open(tmp, 'w', writeMode)
      try {
        await fh.writeFile(buf)
        await fh.chmod(writeMode)
      } finally {
        await fh.close()
      }
      await fsp.rename(tmp, path)
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
    const st = await quietStat(path)
    return { version: versionOf(st) }
  },

  /**
   * Run a command under `bash -c`. The process gets its own session
   * (`detached`) so a timeout can SIGKILL the whole tree via -pid. Output is
   * streamed in ~CHUNK_MAX chunks (events before the exit facts, always), and
   * StringDecoder keeps multi-byte UTF-8 from being cut mid-character.
   */
  async exec({ command, cwd, env, stdin, timeoutMs }, requestId, emit) {
    const child = spawn('bash', ['-c', command], {
      cwd: cwd || process.env.HOME || '/',
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    activeExecs.set(requestId, child)

    const sendChunk = makeChunkSender(requestId, emit)
    if (stdin !== undefined && stdin !== null) {
      child.stdin.write(Buffer.from(stdin, 'base64'))
    }
    child.stdin.end()

    // Attach the stream pumps while the streams are still alive (their 'end'
    // stops existing once 'close' destroys them), arm the timeout before any
    // waiting, then await exit facts and drained streams together.
    let timedOut = false
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
    }
    const streamsDone = Promise.all([pump(child.stdout, 'o', sendChunk), pump(child.stderr, 'e', sendChunk)])
    const exit = await new Promise((resolve) => {
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, signal: null, error: error.message })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, error: null })
      })
    })
    await streamsDone
    activeExecs.delete(requestId)
    return { code: exit.code, signal: exit.signal, error: exit.error, timedOut }
  },

  /** Kill a running exec by its request id. */
  async kill({ target }) {
    const child = activeExecs.get(target)
    if (!child) return { killed: false }
    killTree(child)
    return { killed: true }
  },
}

const activeExecs = new Map()

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function killTree(child) {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {}
  try {
    child.kill('SIGKILL')
  } catch {}
}

function makeChunkSender(requestId, emit) {
  return (stream, buf) => {
    if (buf.length === 0) return
    emit({ id: requestId, ev: stream, d: buf.toString('base64') })
  }
}

function pump(stream, ev, sendChunk) {
  if (!stream) return Promise.resolve() // spawn failed before stdio existed
  return new Promise((resolve) => {
    const finish = () => resolve()
    const decoder = new StringDecoder('utf8')
    let pending = Buffer.alloc(0)
    stream.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= CHUNK_MAX) {
        sendChunk(ev, pending.subarray(0, CHUNK_MAX))
        pending = pending.subarray(CHUNK_MAX)
      }
    })
    stream.on('end', () => {
      // Flush any trailing bytes through the decoder so a split mult-byte
      // sequence at the chunk boundary stays intact, then the remainder.
      const tail = Buffer.from(decoder.end(), 'utf8')
      const rest = Buffer.concat([pending, tail])
      for (let i = 0; i < rest.length; i += CHUNK_MAX) {
        sendChunk(ev, rest.subarray(i, i + CHUNK_MAX))
      }
      finish()
    })
    // A destroyed stream never emits 'end' — 'close' is the safety net.
    stream.on('close', () => finish())
    stream.on('error', () => finish())
  })
}

// ---------------------------------------------------------------------------
// Dispatch loop
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const nl = buffer.indexOf(0x0a)
    if (nl === -1) break
    const line = buffer.subarray(0, nl)
    buffer = buffer.subarray(nl + 1)
    if (line.length > MAX_LINE) continue // over cap, nothing sane to reply to
    handleLine(line.toString('utf8'))
  }
})

process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(1))

function handleLine(text) {
  let req
  try {
    req = JSON.parse(text)
  } catch {
    return
  }
  const { id, op } = req
  if (typeof id !== 'string' && typeof id !== 'number') return
  const emit = (doc) => {
    writeLine(doc).catch(() => {})
  }
  const handler = ops[op]
  if (!handler) {
    emit({ id, ok: false, code: 'EOP', message: `unknown op: ${op}` })
    return
  }
  Promise.resolve()
    .then(() => handler(req, String(id), emit))
    .then(
      (payload) => {
        emit({ id, ok: true, ...(payload || {}) })
      },
      (error) => {
        emit({
          id,
          ok: false,
          code: errnoCode(error),
          message: error && error.message ? String(error.message) : String(error),
        })
      },
    )
}

// Keep stdin flowing even when idle; nothing else holds the loop alive.
setInterval(() => {}, 60_000).unref()
