/**
 * dsh-wsl-overlay — search tools inside the WSL world.
 *
 * A plain function plugin mounted in the preset variant's world group. It
 * registers `grep` and `glob` — deliberately the same tool names the host
 * composition ships — backed by the distro's own ripgrep through the resident
 * agent channel, so in a `wsl-<mode>` session the model's search calls hit
 * Linux files with Linux semantics and no 9P round trip.
 */
import { channelFor } from './channel.js'
import { defaultDistro } from './distro.js'
import { parseUnc } from './paths.js'

const OUTPUT_CAP_BYTES = 1024 * 1024
const MAX_MATCH_LINES = 2000
const SEARCH_TIMEOUT_MS = 120_000

const GREP_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax).' },
    path: { type: 'string', description: 'Directory or file to search, absolute in the WSL world (e.g. /home/you/project). Defaults to the session workspace root.' },
    caseSensitive: { type: 'boolean', description: 'Search case-sensitively. Default: case-insensitive.' },
    include: { type: 'string', description: 'Optional filename glob to restrict the search (e.g. "*.ts").' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const GLOB_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Filename glob (e.g. "**/*.py", "src/**/*.test.ts").' },
    path: { type: 'string', description: 'Directory to list from, absolute in the WSL world. Defaults to the session workspace root.' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`
}

function truncateToLines(text, cap) {
  const lines = text.split('\n')
  if (lines.length <= cap) return { text, truncated: false }
  return { text: lines.slice(0, cap).join('\n'), truncated: true }
}

function registerTools(ctx, config) {
  /** Channel options for the distro a search should hit: the explicit path's
   *  distro, else the session workspace's, else the system default. */
  async function chanFor(args, exec) {
    const path = typeof args.path === 'string' ? args.path : undefined
    const distro =
      parseUnc(path ?? '')?.distro ??
      parseUnc(typeof exec.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : '')?.distro ??
      config.distro ??
      (await defaultDistro())
    return { distro, nodePath: config.nodePath }
  }

  async function runRg(command, cwd, exec, chan) {
    exec.signal?.throwIfAborted?.()
    const channel = await channelFor(chan)
    let stdoutBytes = Buffer.alloc(0)
    const reply = await channel.request('exec', { command, cwd, timeoutMs: SEARCH_TIMEOUT_MS }, {
      signal: exec.signal,
      onEvent: (doc) => {
        if (doc.ev === 'o') stdoutBytes = Buffer.concat([stdoutBytes, Buffer.from(doc.d, 'base64')])
      },
    })
    return { code: reply.code, stdout: stdoutBytes.toString('utf8') }
  }

  /** Session workspace root as a distro path; HOME when unavailable. */
  function defaultCwd(exec) {
    const cwd = exec.agent?.session?.header?.cwd
    if (typeof cwd === 'string') {
      const unc = parseUnc(cwd)
      if (unc) return unc.path
    }
    return undefined
  }

  if (!ctx.tools || typeof ctx.tools.register !== 'function') return () => {}

  const grep = {
    name: 'grep',
    description:
      'Search file contents inside the WSL distro with ripgrep. Returns matching lines as path:line: text. ' +
      'Use this instead of shell grep/rg for searching Linux files.',
    parameters: GREP_SCHEMA,
    timeoutMs: SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        return { text: 'error: pattern must be a non-empty string', isError: true }
      }
      const flags = ['--line-number', '--no-heading', '--color=never', '--max-columns=400']
      if (!args.caseSensitive) flags.push('--ignore-case')
      if (args.include) flags.push(`--glob=${shellQuote(args.include)}`)
      const target = args.path ? shellQuote(args.path) : '.'
      const command = `rg ${flags.join(' ')} --json --regexp=${shellQuote(args.pattern)} ${target} 2>/dev/null | head -c ${OUTPUT_CAP_BYTES}`
      let result
      try {
        result = await runRg(command, args.path ?? defaultCwd(exec), exec, await chanFor(args, exec))
      } catch (error) {
        return { text: `grep failed: ${error.message}`, isError: true }
      }
      const lines = []
      for (const line of result.stdout.split('\n')) {
        if (!line || lines.length >= MAX_MATCH_LINES) continue
        let doc
        try {
          doc = JSON.parse(line)
        } catch {
          continue
        }
        if (doc.type === 'match') {
          const { path, line_number } = doc.data
          const text = (doc.data.lines?.text ?? '').replace(/\n$/, '')
          lines.push(`${path}:${line_number}: ${text}`)
        }
      }
      if (result.code !== 0 && lines.length === 0 && result.stdout === '') {
        if (result.code === 2) return { text: 'no matches (some directories were unreadable)' }
        return { text: 'no matches' }
      }
      const trunc = truncateToLines(lines.join('\n'), MAX_MATCH_LINES)
      return {
        text: trunc.text + (trunc.truncated ? `\n… output truncated at ${MAX_MATCH_LINES} matches` : ''),
        isError: false,
      }
    },
  }

  const glob = {
    name: 'glob',
    description:
      'List files inside the WSL distro matching a filename glob, newest first. ' +
      'Use this instead of shell find/ls globs for locating Linux files.',
    parameters: GLOB_SCHEMA,
    timeoutMs: SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        return { text: 'error: pattern must be a non-empty string', isError: true }
      }
      const target = args.path ? shellQuote(args.path) : '.'
      const command = `rg --files --sort=modified --glob=${shellQuote(args.pattern)} ${target} 2>/dev/null | head -c ${OUTPUT_CAP_BYTES}`
      let result
      try {
        result = await runRg(command, args.path ?? defaultCwd(exec), exec, await chanFor(args, exec))
      } catch (error) {
        return { text: `glob failed: ${error.message}`, isError: true }
      }
      const trunc = truncateToLines(result.stdout.replace(/\n$/, ''), MAX_MATCH_LINES)
      if (!trunc.text) return { text: 'no files match', isError: false }
      return {
        text: trunc.text + (trunc.truncated ? `\n… output truncated` : ''),
        isError: false,
      }
    },
  }

  const disposers = [ctx.tools.register(grep), ctx.tools.register(glob)]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }
}

export const name = 'search-wsl'
export const inject = ['tools']

export function apply(ctx, config) {
  ctx.effect(() => registerTools(ctx, config), 'dsh-wsl-overlay: grep/glob tools')
}
