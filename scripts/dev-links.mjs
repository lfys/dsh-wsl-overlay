/**
 * Dev-only helper: link the @deepseek-ai peer packages from the installed dsh
 * CLI into this package's node_modules so bare imports resolve for LOCAL runs
 * (tests, web profile via `link:` install). The junction farm lives inside
 * node_modules and is never published or installed downstream — profiles and
 * npm consumers resolve the peers through the host instead.
 *
 * Not used by the desktop profile: its loader resolves peer imports against
 * the app's own runtime scope (autoInstallPeers is off there by design).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const target = join(pkgRoot, 'node_modules', '@deepseek-ai')

const CLI_DSH = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PEERS = ['cordis', 'dsh-fs', 'dsh-fs-patch', 'dsh-shell', 'dsh-subprocess', 'dsh-timeout', 'schemastery']

let created = 0
for (const name of PEERS) {
  const link = join(target, name)
  if (existsSync(link)) continue
  const source = join(CLI_DSH, name)
  if (!existsSync(source)) {
    console.warn(`dev-links: peer source not found, skipping ${name} (${source})`)
    continue
  }
  mkdirSync(target, { recursive: true })
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, source], { stdio: 'pipe' })
  if (result.status !== 0) {
    console.warn(`dev-links: mklink failed for ${name}: ${result.stderr?.toString().trim()}`)
  } else {
    created += 1
  }
}
console.log(`dev-links: ${created} junction(s) created`)
