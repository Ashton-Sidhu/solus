import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import type { Metafile } from 'esbuild'
import { spawnSync } from 'node:child_process'

// WHY: plans/013 composes the record service into the private cloud application,
// and the dependency must run one way only. The record service the cloud loads must
// not start, or carry, host execution: no session runtime, agent backend, automation
// scheduler, or browser driver. And nothing a desktop, standalone host, or web client
// runs may reach Better Auth's server or the private cloud repository: local work
// needs no account and no cloud service.

const repoRoot = resolve(import.meta.dir, '../..')
// The same externals as scripts/package-server.ts `bundleServerEntry`.
const external = ['electron', 'electron-updater', '@ff-labs/fff-node', 'onnxruntime-node', 'playwright-core', '*.node']

/** The bundle graph the release's esbuild sees (the CLI, as scripts/package-server.ts runs it). */
function graphOf(entry: string): Metafile {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-build-boundaries-'))
  try {
    const result = spawnSync(join(repoRoot, 'node_modules/.bin/esbuild'), [
      join(repoRoot, entry), '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--log-level=error',
      '--define:import.meta.url=__filename', `--outfile=${join(directory, 'out.cjs')}`, `--metafile=${join(directory, 'meta.json')}`,
      ...external.map(name => `--external:${name}`),
    ], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function externalImports(metafile: Metafile): Set<string> {
  const paths = new Set<string>()
  for (const output of Object.values(metafile.outputs)) for (const item of output.imports) if (item.external) paths.add(item.path)
  return paths
}

const cloudOnly = /(^|\/)(better-auth|@better-auth|solus-cloud)(\/|$)/

test('the record service bundle carries no host execution and needs only Node built-ins', () => {
  const graph = graphOf('packages/server/src/boot-solus-api.ts')
  const inputs = Object.keys(graph.inputs)
  expect(inputs).toContain('packages/server/src/boot-solus-api.ts')
  const forbidden = [
    'packages/server/src/execution/session-runtime.ts',
    'packages/server/src/execution/agents/backend-registry.ts',
    'packages/server/src/execution/automations/scheduler.ts',
    'packages/server/src/browser/playwright-host.ts',
    'packages/server/src/boot-core.ts',
    'packages/server/src/boot-server.ts',
  ]
  expect(inputs.filter(input => forbidden.includes(input))).toEqual([])
  expect(inputs.filter(input => /node_modules\/(@anthropic-ai\/claude-agent-sdk|@openai\/codex|playwright)/.test(input))).toEqual([])
  expect(inputs.filter(input => cloudOnly.test(input))).toEqual([])
  // ws's optional native accelerators are tried inside a try/catch and may be absent.
  const optional = new Set(['bufferutil', 'utf-8-validate'])
  // `node:sqlite` exists only under its prefix, so it is missing from Bun's `builtinModules`.
  const builtins = new Set([...builtinModules.flatMap(name => [name, `node:${name}`]), 'node:sqlite'])
  expect([...externalImports(graph)].filter(path => !builtins.has(path) && !optional.has(path))).toEqual([])
})

test('the standalone host and desktop main reach no account server or cloud code', () => {
  for (const entry of ['apps/standalone-server/src/index.ts', 'apps/desktop/src/main/index.ts']) {
    const graph = graphOf(entry)
    expect(Object.keys(graph.inputs).length).toBeGreaterThan(100)
    expect(Object.keys(graph.inputs).filter(input => cloudOnly.test(input))).toEqual([])
    expect([...externalImports(graph)].filter(path => cloudOnly.test(path))).toEqual([])
  }
})

test('no client or shared package imports Better Auth or the cloud repository', () => {
  // The renderer graphs are Svelte, which esbuild cannot follow: every import
  // specifier in their sources and manifests is checked instead.
  const roots = ['apps/client', 'apps/desktop', 'apps/standalone-server', 'apps/cli', 'packages']
  const specifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  const offenders: string[] = []
  const visit = (path: string) => {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
      const child = join(path, name)
      if (statSync(child).isDirectory()) { visit(child); continue }
      if (name === 'package.json') {
        const manifest: { dependencies?: { [name: string]: string }; devDependencies?: { [name: string]: string } } = JSON.parse(readFileSync(child, 'utf8'))
        for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) if (cloudOnly.test(dependency)) offenders.push(`${child}: ${dependency}`)
        continue
      }
      if (!/\.(ts|js|svelte)$/.test(name)) continue
      for (const match of readFileSync(child, 'utf8').matchAll(specifier)) if (cloudOnly.test(match[1])) offenders.push(`${child}: ${match[1]}`)
    }
  }
  for (const root of roots) visit(join(repoRoot, root))
  expect(offenders).toEqual([])
})
