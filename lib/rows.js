/**
 * dsh-wsl-overlay — preset composition rewriting.
 *
 * A preset document is a YAML sequence of loader entries (`!!js` expressions
 * included). We parse to rows, edit rows by id, and dump back — nesting is
 * irrelevant by construction (the line-span approach misses nested rows,
 * dsh-wsl-workspace#132). The transform shape follows the ecosystem's proven
 * practice; the `!!js` node form is the loader's own contract
 * (`isJsExpr` reads `__jsExpr`, cordis-plugin-loader).
 */
import yaml from 'js-yaml'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { parseUnc } from './paths.js'

/** A `!!js` scalar as the host loader recognizes it. */
export function isJsNode(value) {
  return value instanceof Object && Object.hasOwn(value, '__jsExpr')
}

const JS_TAG = 'tag:yaml.org,2002:js'

const SCHEMA = yaml.JSON_SCHEMA.extend([
  new yaml.Type(JS_TAG, {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: isJsNode,
    represent: (value) => value.__jsExpr,
  }),
])

const DUMP_OPTIONS = { schema: SCHEMA, lineWidth: -1, noRefs: true, quotingType: "'" }

/** Parse a preset document into its top-level rows. */
export function parseRows(source) {
  const doc = yaml.load(source, { schema: SCHEMA })
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) throw new Error('preset document is not a YAML sequence')
  return doc
}

/** Serialize rows back to a preset document. */
export function dumpRows(rows) {
  return yaml.dump(rows, DUMP_OPTIONS)
}

/** Drop a `disabled` gate that a `!!js` expression produced. The gate tests
 *  the platform the LOADER runs on (Windows), not the WSL world the row is
 *  about to live in; left in place it disables the tool. A literal
 *  `disabled: true` is an author's deliberate choice and survives. */
export function clearHostGate(row) {
  if (isJsNode(row.disabled)) delete row.disabled
}

/** Rows this plugin owns and removes from a source preset before re-adding. */
const WORLD_ROWS = new Set([
  'wsl-world',
  'shell-wsl',
  'fs-wsl',
  'sandbox-wsl',
  'search-wsl',
  'jobs-wsl',
  'read-image-wsl',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'str-replace-editor',
  'tool-str-replace-editor',
  'filesystem',
  'persistent-shell',
  'persistent-bash',
  'bash-wsl',
  'persistent-pwsh',
  'terminal-bash',
  'terminal-pwsh',
  'custom-bash',
  'bootstrap-filesystem',
])

const CONSUMER_ROWS = new Set(['tool-bash', 'tool-fs', 'str-replace-editor', 'tool-str-replace-editor'])

const PERSONA_ROW = 'persona'
const SKILL_FILESYSTEM_ROW = 'skill-filesystem'

/**
 * Appended once to the persona text. Deliberately carries no `{{…}}` group:
 * the host registers only `provider` and `model` as template variables, so a
 * `{{cwd}}` here failed every session at turn 1.
 */
export const PERSONA_APPEND =
  ' Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.'

/** Build the `wsl-world` group: the three providers, then the consumer rows
 *  collected out of the source composition. `isolate` on `shell` and `fs`
 *  gives the variant its own instances of those services without hiding them
 *  from the rest of the host. The distro is intentionally NOT pinned: the
 *  providers read it from the path they are handed, so one variant covers
 *  every distribution. */
export function wslWorldGroup(paths, consumers) {
  const provider = (id, name) => ({ id, name })
  return {
    id: 'wsl-world',
    name: 'cordis:group',
    group: true,
    isolate: { shell: true, fs: true },
    config: [
      provider('shell-wsl', paths.shell),
      provider('fs-wsl', paths.fs),
      { id: 'search-wsl', name: paths.search, ...(paths.nodePath ? { config: { nodePath: paths.nodePath } } : {}) },
      ...consumers,
    ],
  }
}

/** Collect the consumer rows a preset declares, in order, wherever they sit. */
export function consumersOf(rows) {
  const found = []
  const walk = (list) => {
    for (const row of list) {
      const id = row?.id
      if (typeof id === 'string' && CONSUMER_ROWS.has(id)) {
        clearHostGate(row)
        found.push(row)
        continue
      }
      const config = row?.config
      if (Array.isArray(config)) walk(config)
    }
  }
  walk(rows)
  return found
}

/** True when a row (at any depth) mounts the subagent delegation plugin. */
function mountsSubagentDelegation(row) {
  if (row?.name === '@deepseek-ai/dsh-tool-subagent') return true
  const config = row?.config
  if (!Array.isArray(config)) return false
  return config.some((child) => child !== null && typeof child === 'object' && mountsSubagentDelegation(child))
}

/** True for a row (or group) this plugin owns and replaces. */
function isWorldRow(row) {
  const id = typeof row?.id === 'string' ? row.id : undefined
  if (id !== undefined && WORLD_ROWS.has(id)) return true
  return typeof id === 'string' && /^wsl-world\b/.test(id)
}

const PERSONA_FIELDS = ['suffix', 'text', 'prefix']

function appendPersona(row, sentence) {
  const config = row?.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return
  if (config.complete === true) return // author declares the text final
  for (const field of PERSONA_FIELDS) {
    const value = config[field]
    if (typeof value !== 'string' || value.length === 0 || value.includes(sentence)) continue
    config[field] = value + sentence
    return
  }
}

/** The skill catalog is withheld while a filesystem snapshot is incomplete,
 *  and a watcher cannot watch a path inside a distribution — it would never
 *  complete, so switch it off. */
function disableSkillWatch(row) {
  const config = row?.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return
  config.watch = false
}

/**
 * Rewrite one preset composition for use inside a WSL distribution.
 * Retains every source row except the rows this plugin owns/replaces and the
 * subagent delegation (its nested composition would re-enter the host world),
 * then appends the WSL world group.
 */
export function transformVariant(source, { world, dropSubagentDelegation = true, personaAppend = PERSONA_APPEND } = {}) {
  const sourceRows = parseRows(source)
  const kept = []
  const seen = new Set()
  let droppedDelegation = false

  for (const row of sourceRows) {
    const id = typeof row?.id === 'string' ? row.id : undefined
    if (id !== undefined) {
      if (seen.has(id)) continue // a duplicate id is a loader error
      if (isWorldRow(row)) continue
      seen.add(id)
    }
    if (dropSubagentDelegation && mountsSubagentDelegation(row)) {
      droppedDelegation = true
      continue
    }
    clearHostGate(row)
    kept.push(row)
  }

  const persona = kept.find((row) => row.id === PERSONA_ROW)
  if (persona !== undefined) appendPersona(persona, personaAppend)

  const skills = kept.find((row) => row.id === SKILL_FILESYSTEM_ROW)
  if (skills !== undefined) disableSkillWatch(skills)

  return { rows: [...kept, ...world], droppedDelegation }
}

/** Absolute `file://` entry URL — a bare Windows path has no URL scheme the
 *  loader's `import()` accepts (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). */
export function entryUrl(name) {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  return pathToFileURL(join(packageRoot, 'lib', name)).href
}

/** True for an id this plugin generates, so a variant is never re-transformed. */
export function isWslVariantId(id) {
  return id === 'wsl' || /^wsl-[a-z0-9-]+$/.test(id)
}

/** The variant id published for a source preset. */
export function variantIdFor(sourceId) {
  return `wsl-${sourceId.toLowerCase()}`
}

/** Resolve a session/workspace path to { distro, path } when it names one. */
export function distroOfPath(path) {
  const unc = parseUnc(typeof path === 'string' ? path : '')
  return unc // { distro, path } | undefined
}
