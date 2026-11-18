/**
 * dsh-wsl-overlay — distribution discovery.
 *
 * `wsl.exe` honors Microsoft's documented `WSL_UTF8=1` switch and writes
 * UTF-8 instead of its default UTF-16LE, which keeps parsing boring. The
 * world group serves whichever distribution a session path names; these
 * helpers only pick the fallback for paths that are already POSIX.
 */
import { spawn } from 'node:child_process'

const CACHE_TTL_MS = 60_000

let cache = { at: 0, distros: [] }

function runWsl(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`wsl.exe ${args.join(' ')} timed out`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`wsl.exe ${args.join(' ')} exited ${code}`))
    })
  })
}

/** Installed distributions: [{ name, default }] — docker-desktop excluded. */
export async function listDistros() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.distros
  let text
  try {
    text = await runWsl(['-l', '-v'])
  } catch {
    return []
  }
  const distros = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\*?)\s+(\S+)\s+\w+\s+\d+\s*$/.exec(line)
    if (!match) continue
    if (/^docker-desktop/.test(match[2])) continue
    distros.push({ name: match[2], default: match[1] === '*' })
  }
  cache = { at: Date.now(), distros }
  return distros
}

/** Fallback distribution for POSIX-only paths: the default one, else the first. */
export async function defaultDistro() {
  const distros = await listDistros()
  return distros.find((d) => d.default)?.name ?? distros[0]?.name
}
