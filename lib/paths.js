/**
 * dsh-wsl-overlay — path translation between the Windows and Linux views.
 *
 * There is deliberately no forward `/mnt/<drive>` → drive-letter translation:
 * Windows cannot resolve anything below `/mnt` (drvfs mounts exist only
 * inside the distro), so a path rooted in Linux is simply not addressable
 * from the Windows half. Translation is one-way: Windows drive paths go
 * into the distro, WSL UNC paths come out.
 */

const UNC_RE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/i
const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const DRIVE_RE = /^([A-Za-z]):(?:[\\/](.*))?$/

/** Parse a `\\wsl.localhost\<distro>\...` (or `\\wsl$\<distro>\...`) path. */
export function parseUnc(input) {
  if (typeof input !== 'string') return undefined
  const normalized = input.replace(/\//g, '\\')
  const match = UNC_RE.exec(normalized)
  if (!match) return undefined
  const distro = match[1]
  if (!DISTRO_RE.test(distro)) return undefined
  const rest = match[2] ?? ''
  return { distro, path: posixJoin('/', rest.replace(/\\/g, '/')) }
}

/** Render a distro + POSIX path as a Windows UNC path (backslash-separated). */
export function toUnc(distro, posixPath) {
  const rest = String(posixPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}\\${rest}`
}

/** `/mnt/<drive>/...` equivalent of a Windows path, or null when unmappable. */
export function driveToMnt(input) {
  if (typeof input !== 'string') return null
  const match = DRIVE_RE.exec(input)
  if (!match) return null
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  return posixJoin(`/mnt/${match[1].toLowerCase()}`, rest)
}

/** POSIX normalize + join, without touching `..` semantics beyond cleanup. */
export function posixJoin(base, ...parts) {
  let joined = base
  for (const part of parts) {
    if (!part) continue
    joined = `${joined.replace(/\/+$/, '')}/${String(part).replace(/^\/+/, '')}`
  }
  return joined.replace(/\/{2,}/g, '/') || '/'
}

/**
 * Boundary-safe POSIX containment: `path` is `root` itself or lives below it,
 * at a path-component boundary. Never a bare string prefix (`/home/u` must
 * not admit `/home/user2`).
 */
export function containsPosix(root, path) {
  const a = normalizePosix(root)
  const b = normalizePosix(path)
  if (a === b) return true
  return b.startsWith(a.endsWith('/') ? a : `${a}/`)
}

export function normalizePosix(path) {
  const cleaned = String(path).replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return cleaned === '' ? '/' : cleaned
}

/**
 * Map a workspace root (UNC or drive path) into a POSIX path inside the
 * distro. UNC paths map through their distro; drive paths map through
 * /mnt. Returns { distro, path } or null when the root cannot be mapped —
 * an unmappable root must never widen the fence, so callers treat null as
 * "deny", not "allow".
 */
export function mapRoot(root) {
  const unc = parseUnc(root)
  if (unc) return unc
  const mnt = driveToMnt(root)
  if (mnt) return { distro: null, path: mnt } // distro filled in by the caller
  return null
}
