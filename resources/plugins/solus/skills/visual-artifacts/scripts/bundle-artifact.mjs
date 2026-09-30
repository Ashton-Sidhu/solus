import { readFile, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function assembleHtml(shell, javascript, css) {
  for (const marker of ['<!-- artifact:styles -->', '<!-- artifact:script -->']) {
    if (shell.split(marker).length !== 2) throw new Error(`index.html must contain exactly one ${marker}`)
  }
  if (!/<!doctype html>/i.test(shell) || !/<title>[^<]+<\/title>/i.test(shell)) {
    throw new Error('index.html needs a doctype and a non-empty title.')
  }
  if (/<script\b|<link\b|\b(?:src|href)\s*=\s*["'](?!data:|#)/i.test(shell)) {
    throw new Error('Keep index.html free of scripts and external assets. Import assets from src instead.')
  }
  const safeScript = javascript
    .replace(/<!--/g, '\\x3c!--')
    .replace(/<\/script/gi, '<\\/script')
  const safeCss = css.replace(/<\/style/gi, '<\\/style')
  return shell
    .replace('<!-- artifact:styles -->', () => `<style>${safeCss}</style>`)
    .replace('<!-- artifact:script -->', () => `<script>${safeScript}</script>`)
}

export async function bundleArtifact(directory) {
  const projectDirectory = await realpath(resolve(directory))
  const require = createRequire(resolve(projectDirectory, 'package.json'))
  const { build } = require('esbuild')
  const postcss = require('postcss')
  const tailwind = require('@tailwindcss/postcss')
  const typescriptManifest = require.resolve('typescript/package.json')
  const typescript = require('typescript/package.json')
  const typecheck = resolve(dirname(typescriptManifest), typescript.bin.tsc)
  execFileSync(process.execPath, [typecheck, '--noEmit', '--project', resolve(projectDirectory, 'tsconfig.json')], {
    cwd: projectDirectory,
    stdio: 'inherit',
  })
  const stylesheet = resolve(projectDirectory, 'src/styles.css')
  const result = await build({
    absWorkingDir: projectDirectory,
    entryPoints: ['src/main.tsx'],
    outfile: 'artifact.js',
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: Object.fromEntries([
      '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
      '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.webm',
    ].map(extension => [extension, 'dataurl'])),
    plugins: [{
      name: 'artifact-tailwind',
      setup(builder) {
        builder.onLoad({ filter: /styles\.css$/ }, async ({ path }) => {
          if (path !== stylesheet) return
          const source = await readFile(path, 'utf8')
          const processed = await postcss([tailwind({ base: projectDirectory, optimize: true })]).process(source, { from: path })
          return { contents: processed.css, loader: 'css', resolveDir: resolve(projectDirectory, 'src') }
        })
      },
    }],
  })
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap(output => output.imports)
    .filter(dependency => dependency.external && !dependency.path.startsWith('data:'))
  if (externalImports.length) throw new Error(`Bundle has external dependencies: ${externalImports.map(dependency => dependency.path).join(', ')}`)
  const scripts = result.outputFiles.filter(file => file.path.endsWith('.js'))
  const styles = result.outputFiles.filter(file => file.path.endsWith('.css'))
  if (scripts.length !== 1 || styles.length > 1 || scripts.length + styles.length !== result.outputFiles.length) {
    throw new Error('Expected one JavaScript bundle and at most one stylesheet, with no separate assets or chunks.')
  }
  const shell = await readFile(resolve(projectDirectory, 'index.html'), 'utf8')
  const html = assembleHtml(shell, scripts[0].text, styles[0]?.text ?? '')
  const bytes = Buffer.byteLength(html)
  if (bytes > 8 * 1024 * 1024) throw new Error('Artifact exceeds 8 MiB. Reduce data, assets, or dependencies.')
  const output = resolve(projectDirectory, 'bundle.html')
  const temporary = `${output}.${process.pid}.tmp`
  try {
    await writeFile(temporary, html, { flag: 'wx' })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return { output, bytes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    console.error('Usage: node bundle-artifact.mjs [artifact-directory]')
    process.exitCode = 1
  } else {
    try {
      const { output, bytes } = await bundleArtifact(process.argv[2] ?? process.cwd())
      console.log(`Artifact ready: ${output} (${Math.ceil(bytes / 1024)} KiB)`)
    } catch (error) {
      console.error(`Artifact bundle failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
