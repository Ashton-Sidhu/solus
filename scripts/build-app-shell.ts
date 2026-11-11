import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

/**
 * Builds the app shell (docs/plans/apps.md §2 decision 3): one minified
 * script with React, TanStack Query, Recharts, Lucide, the Tailwind browser
 * runtime, and the `tools` proxy. The server inlines it into every app's
 * document. Output: `resources/app-shell/shell.js`, gitignored, copied by the
 * packaged server and shipped by the desktop app like `resources/plugins`.
 *
 * Small and separate from the app build on purpose: one esbuild pass, under a
 * second, so the dev script runs it at start.
 */

const repoRoot = resolve(import.meta.dir, '..')
const outputDir = join(repoRoot, 'resources', 'app-shell')
const outputFile = join(outputDir, 'shell.js')

mkdirSync(outputDir, { recursive: true })
build({
  entryPoints: [join(repoRoot, 'packages', 'app-shell', 'src', 'shell.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  legalComments: 'none',
  logLevel: 'warning',
  outfile: outputFile,
})
  .then(() => {
    const { size } = statSync(outputFile)
    writeFileSync(join(outputDir, 'BUILD.json'), JSON.stringify({ builtAt: new Date().toISOString(), bytes: size }, null, 2))
    console.log(`Built the app shell: ${outputFile} (${(size / 1024).toFixed(0)} KB)`)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
