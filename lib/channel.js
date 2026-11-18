/**
 * dsh-wsl-overlay — the host half of the agent channel.
 *
 * One persistent agent process per `<distro>\0<nodePath>`, speaking JSON
 * lines over the stdin/stdout of `wsl.exe --exec`. The channel keeps no
 * state about callers: requests are paired by id, timeouts and aborts
 * cancel the WAIT only (the agent keeps running the operation), and a dead
 * channel is reopened transparently by the next `channelFor` call.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { driveToMnt } from './paths.js'

export const IDLE_TTL_MS = 10 * 60 * 1000
export const BOOT_TIMEOUT_MS = 60 * 1000 // WSL cold start can take half a minute
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000 // 0 disables the wait limit
const MAX_LINE = 96 * 1024 * 1024

export class ChannelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
  }
}

const agentPathCache = {}

/** Absolute package path of agent.mjs as a distro path, or null. */
export function agentPathInDistro() {
  if (agentPathCache.value !== undefined) return agentPathCache.value
  const hostPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'agent.mjs')
  const mnt = driveToMnt(hostPath)
  agentPathCache.value = mnt
  return mnt
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class Channel {
  distro
  nodePath
  bootTimeoutMs
  idleTtlMs
  onDie

  child = null
  closed = false
  ready = false
  nextId = 1
  pending = new Map() // id -> { resolve, reject, onEvent, timer }
  buffer = Buffer.alloc(0)
  idleTimer = null

  constructor({ distro, nodePath, bootTimeoutMs = BOOT_TIMEOUT_MS, idleTtlMs = IDLE_TTL_MS, onDie }) {
    this.distro = distro
    this.nodePath = nodePath
    this.bootTimeoutMs = bootTimeoutMs
    this.idleTtlMs = idleTtlMs
    this.onDie = onDie
  }

  /** Spawn the agent and wait for the first ping round-trip. */
  async start() {
    const agentPath = agentPathInDistro()
    if (!agentPath) {
      throw new ChannelError(
        'EAGENTPATH',
        'dsh-wsl-overlay is not installed on a drive the distro mounts under /mnt; the agent script is unreachable from inside WSL',
      )
    }
    this.child = spawn('wsl.exe', ['-d', this.distro, '--exec', this.nodePath, agentPath], {
      stdio: ['pipe', 'pipe', 'ignore'], // wsl.exe prints noisy proxy notices on stderr
      windowsHide: true,
    })
    this.child.on('exit', () => this.die('ECHILDEXIT', 'agent process exited'))
    this.child.on('error', (error) =>
      this.die('ECHANNEL', error.code === 'ENOENT' ? 'wsl.exe not found on PATH' : error.message),
    )
    this.child.stdout.on('data', (chunk) => this.ingest(chunk))

    // WSL cold start plus agent boot; a fast ping proves the pipe works.
    const bootDeadline = Date.now() + this.bootTimeoutMs
    for (;;) {
      if (this.closed) throw new ChannelError('ECHANNEL', 'agent failed to boot')
      try {
        await this.request('ping', {}, { timeoutMs: Math.max(1000, bootDeadline - Date.now()) })
        break
      } catch (error) {
        if (Date.now() >= bootDeadline) {
          this.die('ENOAGENT', nodeHint(this.nodePath, error))
          throw new ChannelError('ENOAGENT', nodeHint(this.nodePath, error))
        }
        if (error.code === 'ECHILDEXIT' || error.code === 'ENOAGENT') {
          this.die('ENOAGENT', nodeHint(this.nodePath, error))
          throw new ChannelError('ENOAGENT', nodeHint(this.nodePath, error))
        }
        await sleep(250)
      }
    }
    this.ready = true
    this.touch()
  }

  ingest(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const nl = this.buffer.indexOf(0x0a)
      if (nl === -1) break
      const line = this.buffer.subarray(0, nl)
      this.buffer = this.buffer.subarray(nl + 1)
      if (line.length > MAX_LINE) continue
      this.dispatch(line.toString('utf8'))
    }
  }

  dispatch(text) {
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      return
    }
    const waiter = typeof doc?.id === 'string' || typeof doc?.id === 'number' ? this.pending.get(String(doc.id)) : undefined
    if (!waiter) return
    if (doc.ev === 'o' || doc.ev === 'e') {
      waiter.onEvent?.(doc)
      return
    }
    if (doc.ok === true) waiter.resolve(doc)
    else waiter.reject(new ChannelError(doc.code || 'EIO', doc.message || 'agent error'))
  }

  /**
   * Send one request. Resolves with the full reply document (`ok`, plus the
   * op payload). `onEvent` receives streamed exec chunks. Aborts and
   * timeouts reject the caller's promise only — the agent-side operation
   * keeps running unless the caller issues an explicit `kill`.
   */
  request(op, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onEvent } = {}) {
    if (this.closed) return Promise.reject(new ChannelError('ECHANNEL', 'channel closed'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, onEvent, timer: null }
      let settled = false
      const settle = (fn, error) => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        signal?.removeEventListener('abort', onAbort)
        fn(error)
      }
      const onAbort = () => settle(reject, new ChannelError('EABORTED', `request ${id} aborted`))
      waiter.resolve = (doc) => settle(resolve, doc)
      waiter.reject = (error) => settle(reject, error)
      this.pending.set(id, waiter)
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => settle(reject, new ChannelError('ETIMEOUT', `${op} exceeded ${timeoutMs}ms`)), timeoutMs)
      }
      this.writeLine(JSON.stringify({ id, op, ...params }))
    })
  }

  writeLine(text) {
    if (this.closed) return
    this.touch()
    const ok = this.child.stdin.write(text + '\n')
    if (!ok) this.child.stdin.once('drain', () => {})
  }

  touch() {
    clearTimeout(this.idleTimer)
    if (!this.idleTtlMs) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return this.touch() // work outstanding; keep living
      this.close()
    }, this.idleTtlMs)
    this.idleTimer.unref?.()
  }

  /** Idempotent teardown: reject waiters first, then close the pipe. */
  die(code, message) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer)
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new ChannelError(code, message))
    }
    try {
      this.child?.stdin?.end()
    } catch {}
    try {
      this.child?.kill()
    } catch {}
    this.onDie?.(this)
  }

  close() {
    this.die('ECHANNEL', 'channel closed')
  }
}

function nodeHint(nodePath, error) {
  const detail = error instanceof ChannelError ? error.message : String(error?.message ?? error)
  return (
    `node is not reachable as "${nodePath}" inside the distro (${detail}). ` +
    'Install it with: wsl -d <distro> -u root -- apt install nodejs  — or set the plugin\'s nodePath config to an absolute path.'
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Per-distro singleton registry
// ---------------------------------------------------------------------------

const channels = new Map() // `${distro}\0${nodePath}` -> Promise<Channel>

/**
 * Get (or boot) the channel for a distro. The cached promise lets concurrent
 * callers share one boot; a failed or closed channel evicts itself so the
 * next call starts fresh.
 */
export function channelFor(options) {
  const key = `${options.distro}\0${options.nodePath}`
  let entry = channels.get(key)
  if (!entry) {
    const channel = new Channel({
      ...options,
      onDie: () => {
        if (channels.get(key) === promise) channels.delete(key)
      },
    })
    const promise = channel.start().then(() => channel)
    promise.catch((error) => {
      // Shared-boot rejection must not surface as unhandled, and a failed
      // boot must evict itself so the next call retries from scratch.
      if (channels.get(key) === promise) channels.delete(key)
      return error
    })
    channels.set(key, promise)
    entry = promise
  }
  return entry
}

/** Test/diagnostic hook: enumerate live channels. */
export function liveChannels() {
  return [...channels.keys()]
}
