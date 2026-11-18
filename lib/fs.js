/**
 * dsh-wsl-overlay — the WSL backend for the `fs` capability seam.
 *
 * Loaded as a class plugin inside the `wsl-<mode>` preset variant's isolated
 * service scope, so in a WSL session `ctx.fs` resolves to this instance while
 * the rest of the host keeps its own backend. Targets are realpath-derived
 * POSIX identities inside the distro; display paths are the `\\wsl.localhost`
 * UNC paths the Windows host understands.
 *
 * The distro is the boundary — `sandboxMode` stays `undefined` because there
 * is nothing inside the distro for the host's sandbox policy to fence — but
 * every mutation still builds its own fence from the per-call policy:
 * `read-only` denies, `workspace-write` requires the workspace root (and any
 * additional roots) to map into THIS distro and contain the target at a path
 * boundary. A root that cannot be mapped denies; it must never widen.
 *
 * Class members deliberately use `private`-style ordinary properties, not
 * `#private` fields: cordis wraps services in a Proxy whose receiver is the
 * instance, and `#` fields throw under a foreign receiver.
 */
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import { channelFor } from './channel.js'
import { defaultDistro } from './distro.js'
import { parseUnc, driveToMnt, toUnc, posixJoin, containsPosix, normalizePosix } from './paths.js'

/** Whole-text read cap; larger files must go through streamText/readBytes. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024
/** Exclusive bound for the contextual-diff basis captured before writes. */
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
/** streamText window: readRange bytes per decoded chunk. */
const STREAM_WINDOW_BYTES = 256 * 1024
const MODE_MASK = 0o7777

function assertNotAborted(signal, verb) {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(content) {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

function restoreLineEndings(content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (!replaceAll && replacements > 1) {
    throw new FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

function decodeUtf8Strict(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new FsError('file is not valid UTF-8 text', 'FS_NOT_TEXT')
  }
}

function versionOf(view) {
  if (!view) return FsVersion('absent')
  return FsVersion(`${view.ino}:${view.size}:${view.mtimeMs}:${view.ctimeMs}`)
}

// ---------------------------------------------------------------------------
// Per-target FIFO locks — edits/reads/writes on one target serialize so the
// read-for-basis → guard → publish critical section cannot interleave.
// ---------------------------------------------------------------------------

class TargetLocks {
  locks = new Map()

  withLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const release = run.catch(() => {}).then(() => {
      if (this.locks.get(key) === release) this.locks.delete(key)
    })
    // Store the tail so the next task chains after this one regardless of outcome.
    const tail = run.catch(() => {})
    this.locks.set(key, tail)
    return run
  }

  withLocks(keys, task) {
    const ordered = [...new Set(keys)].sort() // canonical order prevents lock cycles
    return this.withLock(ordered.join('\0'), task)
  }
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

var WslFileSystem = class WslFileSystem extends FileSystem {
  static provide = 'fs'
  static Config = z.object({
    // The distro is intentionally not pinned: requests name it through their
    // path (\\wsl.localhost\<distro>\...), so one backend serves every distro.
    // POSIX-only paths fall back to the system default distro.
    distro: z.string().volatile(),
    nodePath: z.string().default('node').volatile(),
    bootTimeoutMs: z.number().default(60_000).volatile(),
    idleTtlMs: z.number().default(600_000).volatile(),
  })

  config
  locks = new TargetLocks()

  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  /** Channel options for one distro (the path's own, else the fallback). */
  chan(distro) {
    return {
      distro,
      nodePath: this.config.nodePath.get(),
      bootTimeoutMs: this.config.bootTimeoutMs.get(),
      idleTtlMs: this.config.idleTtlMs.get(),
    }
  }

  /** One shared channel request with FS error mapping. exec stdout/stderr are
   *  aggregated onto the reply as `stdout` text for small outputs. */
  async call(op, params, { signal, timeoutMs, distro } = {}) {
    assertNotAborted(signal, op)
    const channel = await channelFor(this.chan(distro ?? (await defaultDistro())))
    const onEvent =
      op === 'exec'
        ? (doc) => {
            reply.stdout += Buffer.from(doc.d, 'base64').toString('utf8')
          }
        : undefined
    const reply = { stdout: '' }
    try {
      const result = await channel.request(op, params, { signal, timeoutMs, onEvent })
      if (op === 'exec') result.stdout = reply.stdout
      return result
    } catch (error) {
      if (error instanceof FsError) throw error
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw new FsError(`${op} ${params.path ?? ''}: ${error.message}`, 'FS_NOT_FOUND')
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new FsError(`${op} ${params.path ?? ''}: ${error.message}`, 'FS_PERMISSION_DENIED')
      }
      if (error.code === 'EABORTED') throw new FsError(`${op} aborted`, 'FS_ABORTED')
      throw error
    }
  }

  // -- path mapping ---------------------------------------------------------

  homeCache = new Map()

  /** The distro user's HOME, resolved once per distro through the login env. */
  async home(distro, signal) {
    const cached = this.homeCache.get(distro)
    if (cached !== undefined) return cached
    const reply = await this.call('exec', { command: 'printf %s "$HOME"', timeoutMs: 10_000 }, { signal, timeoutMs: 15_000, distro })
    if (reply.code !== 0) throw new FsError('could not resolve $HOME inside the distro', 'FS_IO_ERROR')
    const value = reply.stdout || '/'
    this.homeCache.set(distro, value)
    return value
  }

  /** Map any caller path into { distro, posix }: UNC paths name their distro;
   *  everything else lands on the default distro. */
  async address(path, cwd, signal) {
    let raw = String(path ?? '')
    const unc = parseUnc(raw)
    if (unc) return unc
    const distro = await defaultDistro()
    if (!distro) throw new FsError('no WSL distribution installed', 'FS_NOT_FOUND')
    const mnt = driveToMnt(raw)
    if (mnt) return { distro, path: mnt }
    if (raw.startsWith('/')) return { distro, path: normalizePosix(raw) }
    // Relative paths and `~` resolve against the cwd (mapped the same way),
    // or the distro user's HOME.
    let base = await this.home(distro, signal)
    if (cwd) {
      const mapped = await this.address(cwd, undefined, signal)
      base = mapped.path
    }
    if (raw.startsWith('~')) {
      raw = raw.slice(1).replace(/^[\\/]/, '')
      return { distro, path: posixJoin(base, raw) }
    }
    return { distro, path: posixJoin(base, raw) }
  }

  async resolve(path, opts) {
    assertNotAborted(opts?.signal, 'resolve')
    const address = await this.address(path, opts?.cwd, opts?.signal)
    // Follow symlinks for the stable identity; tolerate absence (create flows
    // resolve paths that do not exist yet) by falling back to the lexical path.
    let posix = address.path
    try {
      const reply = await this.call('realpath', { path: posix }, { signal: opts?.signal, timeoutMs: 10_000, distro: address.distro })
      posix = reply.path
    } catch (error) {
      if (!(error instanceof FsError && error.code === 'FS_NOT_FOUND')) throw error
    }
    assertNotAborted(opts?.signal, 'resolve')
    return {
      targetKey: FsTargetKey(`wsl://${address.distro}${posix}`),
      displayPath: toUnc(address.distro, posix),
    }
  }

  /** { distro, posix } from a target key (the inverse of resolve). */
  addressOf(target) {
    const key = String(target.targetKey)
    const match = /^wsl:\/\/([^/]+)(.*)$/.exec(key)
    if (!match) {
      throw new FsError(`target "${target.displayPath}" does not belong to this backend`, 'FS_NOT_FOUND')
    }
    return { distro: match[1], path: match[2] || '/' }
  }

  posixOf(target) {
    return this.addressOf(target).path
  }

  processPath(target) {
    return this.posixOf(target)
  }

  processPathFromHostPath(hostPath) {
    const unc = parseUnc(hostPath)
    if (unc) return unc.path
    const mnt = driveToMnt(hostPath)
    if (mnt) return mnt
    return undefined
  }

  fileUrl(target) {
    return `file://${this.posixOf(target)}`
  }

  contains(parent, child) {
    return containsPosix(this.posixOf(parent), this.posixOf(child))
  }

  // -- sandbox fence --------------------------------------------------------

  /** Throw FS_SANDBOX_DENIED unless this mutation may touch `address` under
   *  `policy`. An unmappable root denies — it must never widen the fence. */
  fence(address, policy) {
    if (!policy) return
    const posix = typeof address === 'string' ? address : address.path
    const distro = typeof address === 'string' ? undefined : address.distro
    if (policy.mode === 'danger-full-access') return
    if (policy.mode === 'read-only') {
      throw new FsError(`write to "${posix}" denied: sandbox mode is read-only`, 'FS_SANDBOX_DENIED')
    }
    const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]
    for (const root of roots) {
      const mapped = this.mapWritableRoot(root)
      if (mapped === null) continue
      if (distro !== undefined && mapped.distro.toLowerCase() !== distro.toLowerCase()) continue
      if (containsPosix(mapped.path, posix)) return
    }
    throw new FsError(`write to "${posix}" denied: outside the writable workspace roots`, 'FS_SANDBOX_DENIED')
  }

  mapWritableRoot(root) {
    const unc = parseUnc(String(root))
    if (unc) return unc
    const mnt = driveToMnt(String(root))
    // A /mnt root has no distro of its own — it exists inside every distro.
    if (mnt) return { distro: null, path: mnt }
    return null
  }

  // -- metadata -------------------------------------------------------------

  async stat(target, signal) {
    const address = this.addressOf(target)
    const reply = await this.call('stat', { path: address.path }, { signal, distro: address.distro })
    const view = reply.view
    if (!view) return undefined
    return { version: versionOf(view), type: view.type, size: view.size }
  }

  async lstat(path, opts, signal) {
    if (String(path ?? '').trim().length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    }
    const address = await this.address(path, opts?.cwd, signal)
    const reply = await this.call('lstat', { path: address.path }, { signal })
    const view = reply.view
    if (!view) return undefined
    return { version: versionOf(view), type: view.type, size: view.size }
  }

  // -- reads ----------------------------------------------------------------

  async readText(target, signal) {
    const address = this.addressOf(target)
    const reply = await this.call('read', { path: address.path }, { signal, distro: address.distro })
    const buffer = Buffer.from(reply.data, 'base64')
    if (buffer.length > MAX_TEXT_BYTES) {
      throw new FsError(`"${target.displayPath}" exceeds the whole-text read cap`, 'FS_TOO_LARGE')
    }
    if (buffer.includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    return decodeUtf8Strict(buffer)
  }

  async *streamTextGenerator(target, signal) {
    const address = this.addressOf(target)
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new FsError(`"${target.displayPath}" no longer exists`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let offset = 0
    while (offset < info.size) {
      assertNotAborted(signal, 'read')
      const length = Math.min(STREAM_WINDOW_BYTES, info.size - offset)
      const reply = await this.call('readRange', { path: address.path, offset, length }, { signal, distro: address.distro })
      const window = Buffer.from(reply.data, 'base64')
      if (window.length === 0) break
      offset += window.length
      let text
      try {
        text = decoder.decode(window, { stream: true })
      } catch {
        throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8`, 'FS_NOT_TEXT')
      }
      if (text) yield text
    }
    const tail = decoder.decode()
    if (tail) yield tail
  }

  async streamText(target, signal) {
    // Validate text semantics eagerly (absence/type/binary) so the caller's
    // first next() is never where a missing file surfaces.
    const address = this.addressOf(target)
    const probeReply = await this.call('stat', { path: address.path }, { signal, distro: address.distro })
    if (!probeReply.view) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
    if (probeReply.view.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const head = await this.call('readRange', { path: address.path, offset: 0, length: STREAM_WINDOW_BYTES }, { signal, distro: address.distro })
    if (Buffer.from(head.data, 'base64').includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    return this.streamTextGenerator(target, signal)
  }

  async readBytes(target, signal, maxBytes) {
    const address = this.addressOf(target)
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
    if (info.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if ((info.size ?? 0) > maxBytes) {
      throw new FsError(`"${target.displayPath}" exceeds the ${maxBytes}-byte read cap`, 'FS_TOO_LARGE')
    }
    const reply = await this.call('read', { path: address.path }, { signal, distro: address.distro })
    return new Uint8Array(Buffer.from(reply.data, 'base64'))
  }

  async readByteRange(target, range, signal) {
    const address = this.addressOf(target)
    const reply = await this.call(
      'readRange',
      { path: address.path, offset: range.offset, length: range.length },
      { signal, distro: address.distro },
    )
    return new Uint8Array(Buffer.from(reply.data, 'base64'))
  }

  async listDir(target, signal) {
    const address = this.addressOf(target)
    const reply = await this.call('readdir', { path: address.path }, { signal, distro: address.distro })
    const dirPosix = address.path
    return reply.n.map((name) => {
      const isDir = reply.d.includes(name)
      const isLink = Object.prototype.hasOwnProperty.call(reply.l ?? {}, name)
      const childPosix = posixJoin(dirPosix, name)
      return {
        name,
        type: isDir ? 'directory' : isLink ? 'other' : 'file',
        target: {
          targetKey: FsTargetKey(`wsl://${address.distro}${childPosix}`),
          displayPath: toUnc(address.distro, childPosix),
        },
      }
    })
  }

  // -- text helpers shared by mutations -------------------------------------

  /** Read + decode for edits; FS_NOT_TEXT on binary, LF-normalized + EOL style out. */
  async readForEdit(addressOrPosix, displayPath, signal) {
    const { distro, path: posix } = typeof addressOrPosix === 'string' ? { distro: undefined, path: addressOrPosix } : addressOrPosix
    const reply = await this.call('read', { path: posix }, { signal, distro })
    const buffer = Buffer.from(reply.data, 'base64')
    if (buffer.includes(0)) {
      throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    const raw = decodeUtf8Strict(buffer)
    return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw), version: reply.version }
  }

  /** Best-effort contextual-diff basis: null when non-text, at/over cap, or gone. */
  async diffBasis(distro, posix, signal) {
    try {
      const st = await this.call('stat', { path: posix }, { signal, distro })
      if (!st.view || st.view.type !== 'file') return null
      if (st.view.size >= DIFF_BASIS_MAX_BYTES) return null
      const reply = await this.call('read', { path: posix }, { signal, distro })
      const buffer = Buffer.from(reply.data, 'base64')
      if (buffer.includes(0)) return null
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        return null
      }
      return normalizeLineEndings(text)
    } catch {
      return null // unreadable mid-race: the write still succeeds, basis is best-effort
    }
  }

  /** Guard + stat before any mutation (writeTarget/requireFile semantics). */
  async probeForMutation(target, expected, verb, signal) {
    const existing = await this.stat(target, signal)
    if (existing && existing.type !== 'file') {
      throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (!existing) throw new FsError(`cannot ${verb} "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) {
        throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (expected?.kind === 'createIfAbsent' && existing) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    return existing
  }

  /** Publish `content` (string) or `bytes` (Buffer) with a version CAS. */
  async publish(target, { content, bytes, expectedVersion, mode }, signal, policy) {
    const address = this.addressOf(target)
    this.fence(address, policy)
    const posix = address.path
    const reply = await this.call(
      'write',
      {
        path: posix,
        data: (bytes ?? Buffer.from(content, 'utf8')).toString('base64'),
        ...(mode !== undefined && mode !== null ? { mode } : {}),
        ...(expectedVersion ? { version: expectedVersion } : {}),
      },
      { signal },
    )
    return FsVersion(reply.version)
  }

  // -- mutations ------------------------------------------------------------

  async writeText(target, content, expected, signal, sandboxPolicy) {
    return this.locks.withLock(String(target.targetKey), async () => {
      assertNotAborted(signal, 'write')
      const existing = await this.probeForMutation(target, expected, 'write', signal)
      const sourceAddress = this.addressOf(target)
      const before =
        existing && Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES
          ? await this.diffBasis(sourceAddress.distro, sourceAddress.path, signal)
          : null
      const version = await this.publish(
        target,
        { content, expectedVersion: existing?.version, mode: undefined },
        signal,
        sandboxPolicy,
      )
      return {
        operation: existing ? 'update' : 'create',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    return this.locks.withLock(String(target.targetKey), async () => {
      assertNotAborted(signal, 'edit')
      const existing = await this.probeForMutation(target, expected, 'edit', signal)
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      const sourceAddress = this.addressOf(target)
      const original = await this.readForEdit(sourceAddress, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const diskContent = restoreLineEndings(edited.content, original.lineEndings)
      const version = await this.publish(
        target,
        { content: diskContent, expectedVersion: existing.version },
        signal,
        sandboxPolicy,
      )
      return { version, before: original.content, after: edited.content }
    })
  }

  async patchText(target, hunks, expected, signal, sandboxPolicy) {
    return this.locks.withLock(String(target.targetKey), async () => {
      assertNotAborted(signal, 'patch')
      const existing = await this.probeForMutation(target, expected, 'patch', signal)
      if (!existing) throw new FsError(`cannot patch "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      const original = await this.readForEdit(this.addressOf(target), target.displayPath, signal)
      const result = applyHunks(original.content, hunks ?? [])
      if (!result.ok) {
        throw new FsError(
          `patch failed in "${target.displayPath}" at hunk line ${result.failure.hunkLineNumber} (${result.failure.stage} search)`,
          'FS_PATCH_MISMATCH',
        )
      }
      const diskContent = restoreLineEndings(result.after, original.lineEndings)
      const version = await this.publish(
        target,
        { content: diskContent, expectedVersion: existing.version },
        signal,
        sandboxPolicy,
      )
      return { version, before: original.content, after: result.after }
    })
  }

  async deleteFile(target, expected, signal, sandboxPolicy) {
    return this.locks.withLock(String(target.targetKey), async () => {
      assertNotAborted(signal, 'delete')
      const existing = await this.probeForMutation(target, expected, 'delete', signal)
      if (!existing) throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      const address = this.addressOf(target)
      this.fence(address, sandboxPolicy)
      const before = await this.diffBasis(address.distro, address.path, signal)
      const posix = address.path
      if (posix === '/' || posix === '') {
        throw new FsError(`cannot delete "${target.displayPath}": refusing to remove a filesystem root`, 'FS_SANDBOX_DENIED')
      }
      await this.call('exec', { command: `rm -f -- ${shellQuote(posix)}`, timeoutMs: 15_000 }, { signal })
      return { before }
    })
  }

  async moveFile(source, destination, options, signal, sandboxPolicy) {
    if (source.targetKey === destination.targetKey) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    return this.locks.withLocks([String(source.targetKey), String(destination.targetKey)], async () => {
      assertNotAborted(signal, 'move')
      const sourceAddress = this.addressOf(source)
      const sourcePosix = sourceAddress.path
      const existing = await this.probeForMutation(source, options.expectedSource, 'move', signal)
      if (!existing) throw new FsError(`cannot move "${source.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      const sourceBefore = await this.diffBasis(sourceAddress.distro, sourcePosix, signal)

      // Destination guard mirrors writeText's writeTarget (createIfAbsent /
      // replaceIfVersion), then byte-level publish so binary sources move too.
      this.fence(this.addressOf(destination), sandboxPolicy)
      const destExisting = await this.stat(destination, signal)
      if (destExisting && destExisting.type !== 'file') {
        throw new FsError(`cannot write "${destination.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (options.expectedDestination?.kind === 'replaceIfVersion') {
        if (!destExisting) throw new FsError(`cannot write "${destination.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (destExisting.version !== options.expectedDestination.version) {
          throw new FsError(`cannot write "${destination.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (options.expectedDestination?.kind === 'createIfAbsent' && destExisting) {
        throw new FsError(`cannot overwrite existing "${destination.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }

      const sourceBytes = await this.readBytes(source, signal, Number.MAX_SAFE_INTEGER)
      const stReply = await this.call('lstat', { path: sourcePosix }, { signal, distro: sourceAddress.distro })
      const sourceMode = stReply.view ? stReply.view.mode & MODE_MASK : undefined
      const destVersion = await this.publish(
        destination,
        { bytes: Buffer.from(sourceBytes), expectedVersion: destExisting?.version, mode: sourceMode },
        signal,
        sandboxPolicy,
      )
      const destinationOutcome = {
        operation: destExisting ? 'update' : 'create',
        version: destVersion,
        before: sourceBefore,
        after: sourceBefore ?? '',
      }

      const deleteReply = await this.call('exec', { command: `rm -f -- ${shellQuote(sourcePosix)}`, timeoutMs: 15_000 }, { signal })
      if (deleteReply.code !== 0) {
        return {
          sourceBefore,
          destination: destinationOutcome,
          sourceDeleted: false,
          sourceFailure: { code: 'FS_IO_ERROR', message: `rm ${sourcePosix} exited ${deleteReply.code}` },
        }
      }
      return { sourceBefore, destination: destinationOutcome, sourceDeleted: true }
    })
  }

  // -- intentionally unsupported --------------------------------------------

  async watch(target, changed, signal) {
    throw new FsError(
      `watching "${target.displayPath}" is not supported across the WSL boundary; the distro filesystem cannot be observed from the host`,
      'FS_IO_ERROR',
    )
  }

  get sandboxMode() {
    return undefined // the WSL VM is the boundary; nothing inside it for the host to fence
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function shellQuote(path) {
  return `'${String(path).replaceAll("'", `'\\''`)}'`
}

export default WslFileSystem
export { WslFileSystem }
