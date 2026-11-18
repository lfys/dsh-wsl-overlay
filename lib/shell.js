/**
 * dsh-wsl-overlay — the WSL backend for the `shell` capability seam.
 *
 * Loaded as a class plugin in the `wsl-<mode>` preset variant's isolated
 * scope, so in a WSL session `ctx.shell` resolves here and the model-facing
 * Bash tool transparently runs inside the distro. Execution delegates to the
 * host's `subprocess` service with a `wsl.exe` argv — output collection,
 * spill files, grace escalation and composition-teardown joins are the
 * subprocess service's mechanics, so every ShellProcess contract detail
 * (incremental reads, provider-failure notes, background survival) holds
 * without reimplementation.
 *
 * `wsl.exe --cd <linux path>` is what places the shell where the session is:
 * a Windows process cannot hold a UNC directory as its working directory, so
 * the spawn cwd stays on the Windows side and the Linux cwd rides in argv.
 * Environment entries reach the Linux side through WSLENV forwarding.
 */
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseUnc, driveToMnt } from './paths.js'
import { defaultDistro } from './distro.js'

/** Model-friendly terminal overrides, forwarded into the distro via WSLENV. */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

const DEFAULT_GRACE_MS = 3000
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`wsl-overlay: ${name} must be a positive finite number`)
}

/** Compose WSLENV so the forwarded variables actually cross into the distro. */
function wslEnv(entries) {
  const forwarded = [...new Set(Object.keys(entries))]
  if (forwarded.length === 0) return {}
  return { WSLENV: forwarded.join(':') }
}

function finalOutput(reader) {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

var WslShellExecutor = class WslShellExecutor extends ShellExecutor {
  static inject = ['subprocess']
  static Config = z.object({
    // The distro comes from the session path; no pin, one variant per distro.
    distro: z.string().volatile(),
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
    graceMs: z.number().default(DEFAULT_GRACE_MS).volatile(),
  })

  config

  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  resolve(request) {
    const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs.get(), this.config.maxTimeoutMs.get(), 'wsl-overlay: request.timeoutMs')
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes.get()
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd.get() ?? '',
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** Map a workdir from the WSL world into `wsl.exe --cd` form, naming the
   *  distro the path belongs to (or the pinned/default one). */
  async linuxWorkdir(workdir) {
    const unc = parseUnc(workdir)
    if (unc) return { distro: unc.distro, path: unc.path }
    const mnt = driveToMnt(workdir)
    if (mnt) return { distro: this.config.distro.get() ?? (await defaultDistro()), path: mnt }
    if (typeof workdir === 'string' && workdir.startsWith('/')) {
      return { distro: this.config.distro.get() ?? (await defaultDistro()), path: workdir }
    }
    return undefined // unmappable: let the distro pick its default start
  }

  async execute(spec) {
    const workdir = await this.linuxWorkdir(spec.workdir)
    const forwarded = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
    const argv = [
      'wsl.exe',
      '-d',
      workdir?.distro ?? this.config.distro.get() ?? (await defaultDistro()),
      ...(workdir?.path !== undefined ? ['--cd', workdir.path] : []),
      '--',
      'bash',
      '-c',
      spec.command,
    ]
    const spawnSpec = {
      argv,
      // A Windows process cannot hold a UNC directory as its cwd; keep the
      // spawn on the Windows side and let --cd place the Linux shell.
      cwd: process.env.USERPROFILE ?? process.cwd(),
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: this.config.maxSpillBytes.get() } },
        stderr: { maxBytes: this.config.maxOutputBytes.get(), spill: { maxBytes: this.config.maxSpillBytes.get() } },
      },
      graceMs: this.config.graceMs.get(),
      signal: undefined,
      env: { ...forwarded, ...wslEnv(forwarded) },
    }

    // Deadline + first-cause classification, mirroring bash-local: one fused
    // deadline drives timeout and abort so a single cause is reported.
    let classify
    let disarm = () => {}
    let spawnSignal
    if (spec.onExpiry === 'kill') {
      const d = deadline(spec.signal, spec.timeoutMs, 'WSL_TIMEOUT')
      spawnSignal = d.signal
      classify = () => {
        const timedOut = timeoutOf(d.signal, 'WSL_TIMEOUT') !== undefined
        return { timedOut, aborted: d.signal.aborted && !timedOut }
      }
      disarm = () => d[Symbol.dispose]()
    } else {
      spawnSignal = spec.signal
      classify = () => ({ timedOut: false, aborted: spec.signal?.aborted === true })
    }
    spawnSpec.signal = spawnSignal

    let running
    let syncSpawnError
    try {
      running = this.ctx.subprocess.spawn(spawnSpec)
    } catch (error) {
      syncSpawnError = { error }
    }

    const emptyReader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) }
    const collected =
      running !== undefined && running.collected && running.collected.stdout !== undefined && running.collected.stderr !== undefined
        ? running.collected
        : { stdout: emptyReader, stderr: emptyReader }

    const spawnThrow = () => syncSpawnError.error
    const spawned =
      running !== undefined ? running.done : Promise.reject(spawnThrow())
    let providerFailure
    let providerFailureReported = false
    const consumeProviderFailure = () => {
      if (providerFailure === undefined || providerFailureReported) return ''
      providerFailureReported = true
      return providerFailure.note
    }
    const observedStderr = {
      readFrom: (fromByte) => {
        if (providerFailure === undefined) return collected.stderr.readFrom(fromByte)
        const note = Buffer.from(providerFailure.note, 'utf8')
        return {
          text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'),
          nextOffset: note.length,
          lossy: false,
        }
      },
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    let resultPromise
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: { stdout: collected.stdout, stderr: observedStderr },
      done: spawned.then(
        (outcome) => {
          if (proc.status === 'running') {
            proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
          disarm()
        },
        (error) => {
          proc.status = 'killed'
          let detail = 'unprintable provider failure'
          try {
            detail = String(error)
          } catch {}
          providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}` }
          disarm()
        },
      ),
      readOutput: () => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const failure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text + (failure.length > 0 ? `${failureSeparator}${failure}` : '')
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
          ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running?.terminate()
        return true
      },
      result: () => {
        resultPromise ??= proc.done.then(() => {
          if (providerFailure !== undefined) throw providerFailure.error
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            ...classify(),
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(collected.stdout),
            stderr: finalOutput(collected.stderr),
          }
        })
        return resultPromise
      },
    }
    return proc
  }

  get sandboxMode() {
    return undefined // the WSL VM is the boundary; nothing inside it for the host to fence
  }
}

export default WslShellExecutor
export { WslShellExecutor }
