import { compile } from 'svelte/compiler'
import { readFileSync, writeFileSync } from 'node:fs'

const result = await Bun.build({
  entrypoints: [import.meta.dir + '/mount.ts'],
  outdir: 'dist/client/response-fixture',
  target: 'browser',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  conditions: ['svelte', 'browser'],
  splitting: true,
  plugins: [{ name: 'svelte-fixture', setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
      contents: compile(readFileSync(path, 'utf8'), { filename: path, generate: 'client', css: 'injected' }).js.code,
      loader: 'js',
    }))
  } }],
})
if (!result.success) throw new Error(result.logs.join('\n'))

const css = readFileSync('dist/client/index.html', 'utf8').match(/href="([^" ]+\.css)"/)?.[1]
if (!css) throw new Error('Build the client before its response fixture')
writeFileSync('dist/client/response-fixture/index.html', `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><script type="module">import { mountResponseFixture } from './mount.js'; window.responseFixture = mountResponseFixture();</script></body></html>`)
