import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * The native bundle's runtime import graph (plan 017 stage 0). Metro follows
 * the same edges: an import here is code on the phone. A type-only import
 * carries no runtime dependency and is not followed. This is the source-level
 * check; a native build is the separate proof that the bundle compiles.
 */

const root = resolve(import.meta.dir, '../..')
const mobile = join(root, 'apps/mobile')

/** client-core modules that touch the DOM, the Electron bridge, or browser
 *  storage when used. Native code has its own adapters instead. */
const BROWSER_ONLY_CLIENT_CORE = [
  'file-picker', 'local-api', 'native-api-overlay', 'no-host-api', 'ws-browser-api',
  'device-label', 'server-connection', 'server-connections', 'push',
]
const FORBIDDEN_PACKAGES = [/^svelte/, /^@sveltejs\//, /^electron/, /^@solus\/server/, /^@solus\/workspace-ui/, /^dompurify$/, /^jsdom$/, /^@tiptap\//]
const FORBIDDEN_DIRECTORIES = ['packages/server/', 'packages/workspace-ui/', 'apps/desktop/', 'apps/client/', 'apps/site/', 'apps/cli/']
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

interface Graph {
  files: Set<string>
  packages: Map<string, string>
  edges: Array<{ from: string; to: string }>
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const extension of SOURCE_EXTENSIONS) if (existsSync(base + extension)) return base + extension
  return null
}

function resolveSpecifier(from: string, specifier: string): { file: string } | { package: string } {
  if (specifier.startsWith('.')) {
    const file = resolveFile(resolve(dirname(from), specifier))
    if (!file) throw new Error(`unresolved ${specifier} from ${relative(root, from)}`)
    return { file }
  }
  const workspace = /^@solus\/(contracts|client-core)\/(.+)$/.exec(specifier)
  if (workspace) {
    const file = resolveFile(join(root, 'packages', workspace[1]!, 'src', workspace[2]!.replace(/\.json$/, '.json')))
    if (!file) throw new Error(`unresolved ${specifier} from ${relative(root, from)}`)
    return { file }
  }
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
  return { package: name }
}

/** Runtime specifiers of one source file. `import type`, `export type`, and
 *  imports whose every named binding is `type` are not runtime edges. */
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const statement = /(?:^|\n)\s*(import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(statement)) {
    const clause = match[2]!.trim()
    if (/^type\b/.test(clause)) continue
    const named = /^\{([^}]*)\}$/.exec(clause)
    if (named && named[1]!.split(',').map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith('type '))) continue
    specifiers.push(match[3]!)
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]!)
  for (const match of source.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]!)
  return specifiers
}

function nativeEntryPoints(): string[] {
  const files = [join(mobile, 'index.ts')]
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry)) files.push(path)
    }
  }
  walk(join(mobile, 'src'))
  return files
}

function buildGraph(entries: string[]): Graph {
  const graph: Graph = { files: new Set(), packages: new Map(), edges: [] }
  const queue = [...entries]
  while (queue.length) {
    const file = queue.pop()!
    if (graph.files.has(file)) continue
    graph.files.add(file)
    if (file.endsWith('.json')) continue
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, specifier)
      if ('package' in target) {
        if (!graph.packages.has(target.package)) graph.packages.set(target.package, relative(root, file))
        continue
      }
      graph.edges.push({ from: relative(root, file), to: relative(root, target.file) })
      queue.push(target.file)
    }
  }
  return graph
}

describe('native mobile import boundary', () => {
  const graph = buildGraph(nativeEntryPoints())
  const files = [...graph.files].map((file) => relative(root, file))

  test('the native graph reaches the shared transport, not a copy of it', () => {
    expect(files).toContain('packages/client-core/src/ws-transport.ts')
    expect(files).toContain('packages/client-core/src/host-supervisor.ts')
    expect(files).toContain('packages/client-core/src/send-outbox.ts')
    expect(graph.packages.has('socket.io-client')).toBe(true)
  })

  test('no Svelte, Electron, server, or browser-only client module is loaded', () => {
    const forbiddenFiles = files.filter((file) => FORBIDDEN_DIRECTORIES.some((directory) => file.startsWith(directory))
      || BROWSER_ONLY_CLIENT_CORE.some((name) => file === `packages/client-core/src/${name}.ts`))
    const forbiddenPackages = [...graph.packages.keys()].filter((name) => FORBIDDEN_PACKAGES.some((pattern) => pattern.test(name)) || NODE_BUILTINS.has(name))
    const via = (target: string) => graph.edges.filter((edge) => edge.to === target).map((edge) => edge.from)
    expect(forbiddenFiles.map((file) => ({ file, via: via(file) }))).toEqual([])
    expect(forbiddenPackages.map((name) => ({ name, via: graph.packages.get(name) }))).toEqual([])
  })

  test('type-only imports are not followed', () => {
    expect(runtimeSpecifiers("import type { A } from './a'\nimport { type B, type C } from './b'\nexport type { D } from './d'")).toEqual([])
    expect(runtimeSpecifiers("import { type B, c } from './b'\nimport './side-effect'")).toEqual(['./b', './side-effect'])
  })

  test('a browser-only import would be caught', () => {
    const probe = buildGraph([join(root, 'packages/client-core/src/server-connection.ts')])
    expect([...probe.files].map((file) => relative(root, file))).toContain('packages/client-core/src/ws-browser-api.ts')
  })
})
