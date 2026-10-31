import { expect, test } from 'bun:test'
import config from '../../apps/client/vite.config'

const preloads = config.build?.modulePreload
if (!preloads || typeof preloads !== 'object' || !preloads.resolveDependencies) {
  throw new Error('The web client must define its module preload policy')
}
const resolveDependencies = preloads.resolveDependencies

test('dynamic workspace imports do not insert a JavaScript preload link for every dependency', async () => {
  // The Safari recording spent 841 ms in the task that inserted these links.
  // Native ESM must own this graph rather than a synchronous DOM loop.
  const dependencies = Array.from({ length: 204 }, (_, index) => `assets/dependency-${index}.js`)
  expect(await resolveDependencies('assets/App.js', dependencies, {
    hostId: 'assets/entry.js', hostType: 'js',
  })).toEqual([])
})

test('HTML still preloads the entry dependencies before the entry script runs', async () => {
  const dependencies = ['assets/client-core.js', 'assets/runtime.js']
  expect(await resolveDependencies('assets/entry.js', dependencies, {
    hostId: 'index.html', hostType: 'html',
  })).toEqual(dependencies)
})

test('the HTML lists the workspace startup graph and its CSS between the markers the share pages drop', async () => {
  // Without the list the browser finds App's chunks one import level at a time,
  // a round trip per level (docs/benchmarks/web-load-2026-10-30.json).
  const plugin = (config.plugins ?? []).flat().find((each) => each && typeof each === 'object' && 'name' in each && each.name === 'solus-workspace-startup-preloads')
  if (!plugin || typeof plugin !== 'object' || !('transformIndexHtml' in plugin)) throw new Error('The startup preload plugin is missing')
  const hook = plugin.transformIndexHtml as { handler: (html: string, context: { bundle: object }) => string }
  const chunk = (fileName: string, imports: string[], extra: object = {}) => ({ type: 'chunk', fileName, imports, isDynamicEntry: false, moduleIds: [], viteMetadata: { importedCss: new Set<string>() }, ...extra })
  const bundle = {
    'assets/index.js': chunk('assets/index.js', ['assets/shared.js']),
    'assets/App.js': chunk('assets/App.js', ['assets/shared.js', 'assets/store.js'], {
      isDynamicEntry: true, moduleIds: ['/repo/apps/client/src/App.svelte'], viteMetadata: { importedCss: new Set(['assets/App.css']) },
    }),
    'assets/store.js': chunk('assets/store.js', ['assets/deep.js']),
    'assets/deep.js': chunk('assets/deep.js', []),
    'assets/shared.js': chunk('assets/shared.js', []),
    'assets/Settings.js': chunk('assets/Settings.js', [], { isDynamicEntry: true }),
  }
  const html = '<head><script type="module" crossorigin src="/assets/index.js"></script><link rel="modulepreload" crossorigin href="/assets/shared.js"></head>'
  const out = hook.handler(html, { bundle })
  const block = /<!--solus:workspace-preloads-->(.*)<!--\/solus:workspace-preloads-->/.exec(out)?.[1] ?? ''
  expect([...block.matchAll(/rel="modulepreload" crossorigin href="([^"]+)"/g)].map((match) => match[1])).toEqual(['/assets/App.js', '/assets/store.js', '/assets/deep.js'])
  expect(block).toContain('rel="preload" as="style" crossorigin href="/assets/App.css"')
  expect(block).not.toContain('Settings')
})
