/**
 * dsh-wsl-overlay — transparent WSL takeover for DeepSeek Harness.
 *
 * The host half publishes `wsl-<mode>` variants of the profile's own agent
 * presets (their shell/file/search tools run inside a WSL distro), defaults
 * new sessions on WSL workspaces to the WSL variant, wraps the host's
 * terminal spawn so a WSL workspace terminal is a real Linux pty, and
 * registers workspaces as `\\wsl.localhost` UNC paths in the host's own
 * workspace registry — no private store to drift.
 *
 * Degrades gracefully: every host service except `webServer` is joined
 * lazily, so a host without one still loads the plugin (minus that surface).
 */
import z from '@deepseek-ai/schemastery'
import { parseUnc, toUnc, driveToMnt } from './paths.js'
import { listDistros, defaultDistro } from './distro.js'
import { entryUrl, parseRows, wslWorldGroup, transformVariant, consumersOf, variantIdFor, isWslVariantId } from './rows.js'
import { channelFor, liveChannels } from './channel.js'

const POSIX_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'])

// ---------------------------------------------------------------------------
// in-place single-slot wraps (WeakMap ref-counted so two mounts unwind cleanly)
// ---------------------------------------------------------------------------

const PATCHED = new WeakMap()

function patchOwnProperty(obj, prop, install) {
  let state = PATCHED.get(obj)
  if (state === undefined) {
    state = { original: obj[prop], refs: 0 }
    PATCHED.set(obj, state)
  }
  if (state.refs === 0) {
    obj[prop] = install(state.original)
  }
  state.refs += 1
  let restored = false
  return () => {
    if (restored) return
    restored = true
    state.refs -= 1
    if (state.refs === 0) {
      obj[prop] = state.original
      PATCHED.delete(obj)
    }
  }
}

/** `wsl.exe -d <distro> --cd <path> -- <shell> <args>` for a WSL cwd, else
 *  undefined to pass the spec through untouched. */
function terminalSpecFor(spec) {
  const cwd = typeof spec?.cwd === 'string' ? spec.cwd : ''
  const unc = parseUnc(cwd)
  if (!unc) return undefined
  const argv0 = typeof spec.argv?.[0] === 'string' ? spec.argv[0] : 'bash'
  const base = argv0.split(/[\\/]/).pop() ?? 'bash'
  const name = base.replace(/\.exe$/i, '')
  const shell = POSIX_SHELLS.has(name) ? `/bin/${name}` : '/bin/bash'
  return {
    ...spec,
    argv: ['wsl.exe', '-d', unc.distro, '--cd', unc.path, '--', shell, ...spec.argv.slice(1)],
    // A Windows process cannot hold a UNC directory as its working directory;
    // `--cd` is what places the shell where the session actually is.
    cwd: process.env.USERPROFILE ?? 'C:\\',
    env: { ...spec.env, TERM: spec.terminalType },
  }
}

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

/** Whether the plugin's fiber is still alive (cordis nulls uid on disposal). */
function stillActive(ctx) {
  const fiber = ctx?.fiber
  return fiber === undefined ? true : fiber.uid !== null
}

async function materialize(ctx, presets, nodePath) {
  const produced = []
  const failed = []
  const world = (consumers) =>
    wslWorldGroup(
      {
        shell: entryUrl('shell.js'),
        fs: entryUrl('fs.js'),
        search: entryUrl('search.js'),
        nodePath,
      },
      consumers,
    )

  for (const preset of await presets.list()) {
    if (preset.broken !== undefined || isWslVariantId(preset.id)) continue
    if (!stillActive(ctx)) break
    const id = variantIdFor(preset.id)
    try {
      const document = await presets.readDocument(preset.id)
      const transformed = transformVariant(document.content, { world: [world(consumersOf(parseRows(document.content)))] })
      const definition = {
        id,
        name: document.name ?? preset.name ?? preset.id,
        description: 'The same agent, with its shell and file tools running inside WSL.',
        ...(preset.order === undefined ? {} : { order: preset.order }),
        plugins: transformed.rows,
      }
      const dispose = await presets.register(definition)
      try {
        ctx.effect(() => () => void dispose(), `dsh-wsl-overlay: retire preset ${id}`)
      } catch {
        await dispose()
        break // fiber gone mid-registration; nothing more to retire
      }
      produced.push(id)
    } catch (error) {
      failed.push({ id, reason: String(error?.message ?? error) })
    }
  }
  if (failed.length > 0) {
    ctx.logger.warn(`dsh-wsl-overlay: ${failed.length} preset variant(s) not published: ${failed.map((f) => `${f.id} (${f.reason})`).join('; ')}`)
  }
  return { produced, failed }
}

// ---------------------------------------------------------------------------
// WSLWorkspace diagnostic tool
// ---------------------------------------------------------------------------

function registerWorkspaceTool(ctx, config) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return () => {}
  const tool = {
    name: 'WSLWorkspace',
    description:
      'Inspect and manage WSL workspaces for this harness: list installed distros, report plugin status, ' +
      'check a Linux path, or register a Linux directory as a workspace (a \\wsl.localhost path in the host registry).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'listDistros', 'check', 'create'],
          description: 'status: plugin/variant diagnostics. listDistros: installed distros. check: does a Linux path exist. create: register a Linux directory as a workspace.',
        },
        distro: { type: 'string', description: 'Target distro (check/create). Defaults to the system default distro.' },
        path: { type: 'string', description: 'Linux path for check/create (e.g. /home/you/project). /mnt paths cannot be workspace roots.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        if (args.action === 'status') {
          const distros = await listDistros()
          return { text: `dsh-wsl-overlay status:\ndistros: ${distros.map((d) => `${d.name}${d.default ? ' (default)' : ''}`).join(', ') || 'none'}\nlive channels: ${liveChannels().join(', ') || 'none'}`, isError: false }
        }
        if (args.action === 'listDistros') {
          const distros = await listDistros()
          return { text: distros.map((d) => `${d.name}${d.default ? ' (default)' : ''}`).join('\n') || 'no distributions installed', isError: false }
        }
        const distro = args.distro ?? (await defaultDistro())
        if (!distro) return { text: 'no WSL distribution installed', isError: true }
        const registry = ctx.get?.('workspaceRegistry')
        if (args.action === 'check') {
          if (typeof args.path !== 'string' || args.path.length === 0) return { text: 'path is required for check', isError: true }
          const channel = await channelFor({ distro, nodePath: config.nodePath.get() })
          const reply = await channel.request('exec', { command: `test -d -- ${shellQuote(args.path)} && echo dir || test -e -- ${shellQuote(args.path)} && echo other || echo missing`, timeoutMs: 10_000 })
          return { text: `${args.path} in ${distro}: ${reply.stdout.trim()}`, isError: false }
        }
        if (args.action === 'create') {
          if (typeof args.path !== 'string' || args.path.length === 0) return { text: 'path is required for create', isError: true }
          if (!registry || typeof registry.create !== 'function') return { text: 'workspaceRegistry service unavailable on this host', isError: true }
          const posix = args.path.replace(/\/+$/, '') || '/'
          if (posix === '/mnt' || posix.startsWith('/mnt/')) {
            return { text: 'refusing /mnt paths: a workspace root must live in the Linux filesystem (Windows cannot resolve below /mnt). Move the project under /home first.', isError: true }
          }
          const unc = toUnc(distro, posix)
          const existing = await registry.resolveByPath(unc)
          if (existing) return { text: `workspace already registered: ${existing.id} → ${unc}`, isError: false }
          const created = await registry.create(unc, `${distro}:${posix}`)
          return { text: `workspace created: ${created.id} → ${created.path}`, isError: false }
        }
        return { text: `unknown action: ${args.action}`, isError: true }
      } catch (error) {
        return { text: `WSLWorkspace ${args.action} failed: ${error?.message ?? error}`, isError: true }
      }
    },
  }
  const dispose = ctx.tools.register(tool)
  return () => {
    try {
      dispose()
    } catch {}
  }
}

function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

function registerRoute(ctx) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  return webServer.register({
    kind: 'prefix',
    path: '/dsh-wsl-overlay/api',
    handler: async (req, res) => {
      res.setHeader('content-type', 'application/json')
      // Trust boundary: loopback only, JSON bodies only — a web page must not
      // be able to list distros or create workspaces through this route.
      if (!isLoopback(req.socket?.remoteAddress)) {
        res.statusCode = 403
        return res.end(JSON.stringify({ error: 'forbidden' }))
      }
      const url = new URL(req.url ?? '/', 'http://loopback')
      try {
        if (url.pathname.endsWith('/listDistros')) {
          return res.end(JSON.stringify({ distros: await listDistros() }))
        }
        if (url.pathname.endsWith('/status')) {
          const presets = ctx.get?.('agentPresets')
          let ids = []
          try {
            ids = (await presets?.list?.())?.map((p) => p.id).filter((id) => isWslVariantId(id)) ?? []
          } catch {}
          return res.end(JSON.stringify({ distros: await listDistros(), variants: ids, channels: liveChannels() }))
        }
        if (url.pathname.endsWith('/createWorkspace') && req.method === 'POST') {
          const body = await readJsonBody(req)
          const distro = body?.distro ?? (await defaultDistro())
          const posix = typeof body?.path === 'string' ? body.path.replace(/\/+$/, '') || '/' : ''
          const registry = ctx.get?.('workspaceRegistry')
          if (!distro || !posix || !registry) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'distro and path are required' }))
          }
          if (posix.startsWith('/mnt')) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: '/mnt paths cannot be workspace roots' }))
          }
          const unc = toUnc(distro, posix)
          const existing = await registry.resolveByPath(unc)
          const workspace = existing ?? (await registry.create(unc, `${distro}:${posix}`))
          return res.end(JSON.stringify({ id: workspace.id, path: workspace.path, title: workspace.title }))
        }
        res.statusCode = 404
        return res.end(JSON.stringify({ error: 'not found' }))
      } catch (error) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export const name = 'dsh-wsl-overlay'

export const inject = ['webServer', 'tools']

export const Config = z.object({
  defaultPreset: z.string().default('wsl-standard').volatile(),
  nodePath: z.string().default('node').volatile(),
  bootTimeoutMs: z.number().default(60_000).volatile(),
  idleTtlMs: z.number().default(600_000).volatile(),
})

export async function apply(ctx, config) {
  ctx.effect(() => registerRoute(ctx), 'dsh-wsl-overlay: api route')
  ctx.effect(() => registerWorkspaceTool(ctx, config), 'dsh-wsl-overlay: WSLWorkspace tool')

  // Publish wsl-<mode> preset variants once the preset registry is up.
  ctx.inject(['agentPresets'], ({ agentPresets }) => {
    const task = materialize(ctx, agentPresets, config.nodePath.get(), config.defaultPreset.get())
    return () => task
  })

  // Sidebar terminals in a WSL workspace become real Linux ptys.
  ctx.inject(['subprocess'], ({ subprocess }) => {
    return patchOwnProperty(subprocess, 'spawnTerminal', (original) => {
      return function patchedSpawnTerminal(spec) {
        const next = terminalSpecFor(spec) ?? spec
        return original.call(this, next)
      }
    })
  })

  // A new session whose workspace lives in WSL defaults to the WSL variant.
  // An explicit preset pick always wins; a workspace outside WSL is untouched.
  ctx.inject(['sessionController', 'workspaceRegistry'], ({ sessionController, workspaceRegistry }) => {
    return patchOwnProperty(sessionController, 'create', (original) => {
      return async function patchedCreate(request) {
        if (request?.agentPreset !== undefined) return original.call(this, request)
        const targetId = config.defaultPreset.get()
        if (!targetId) return original.call(this, request)
        let path = request?.cwd
        if (typeof path !== 'string' && request?.workspaceId !== undefined) {
          path = workspaceRegistry.get?.(request.workspaceId)?.path
        }
        if (typeof path !== 'string' || !parseUnc(path)) return original.call(this, request)
        // Compose only when the variant exists, so the request fails loudly
        // instead of silently composing the Windows world.
        try {
          const roster = await agentPresetIds(ctx)
          if (!roster.has(targetId)) return original.call(this, request)
        } catch {
          return original.call(this, request)
        }
        return original.call(this, { ...request, agentPreset: targetId })
      }
    })
  })

  ctx.logger.info('dsh-wsl-overlay mounted')
}

async function agentPresetIds(ctx) {
  const presets = ctx.get?.('agentPresets')
  const list = (await presets?.list?.()) ?? []
  return new Set(list.map((p) => p.id))
}
