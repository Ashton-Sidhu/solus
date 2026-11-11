import { readFile, readdir, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// An app (references/apps.md): a project with an app.json. The build then
// writes the app manifest into the page: its permissions, the integrations
// its code names, its host functions bundled for Node, and its sources.

const SERVER_ENTRIES = ['server.ts', 'server.js']
const SOURCE_FOLDERS = ['src']
const SOURCE_FILES = ['package.json', 'app.json', 'index.html', ...SERVER_ENTRIES]
/** Files every new project has from the template: a rebuilt project has them already. */
const TEMPLATE_FILES = new Set(['src/solus-app.ts', 'src/assets.d.ts'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.html', '.md', '.sql', '.svg', '.txt'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MAX_SOURCES_BYTES = 512 * 1024

const extensionOf = (path) => (path.includes('.') ? path.slice(path.lastIndexOf('.')) : '')

/** Blanks comments, keeping length and newlines, so a commented-out `tools.github` is not an integration. */
function withCommentsBlanked(code) {
  return code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
}

const TOOLS_REFERENCE = /(?<![.\w$])tools\s*(?:\.\s*([A-Za-z_$][\w$-]*)|\[\s*(?:"([A-Za-z_$][\w$-]*)"|'([A-Za-z_$][\w$-]*)')\s*\])/g

/** The integration slugs the code reaches through `tools.<slug>`, first use first. */
export function integrationsOf(code) {
  const found = []
  for (const match of withCommentsBlanked(code).matchAll(TOOLS_REFERENCE)) {
    const slug = match[1] ?? match[2] ?? match[3]
    if (slug && !found.includes(slug)) found.push(slug)
  }
  return found
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(path)
    return entry.isFile() ? [path] : []
  }))
  return nested.flat().sort()
}

/** The project's own text files, by path from the project root; null when they are too large to carry. A later session reads them from the saved app and rebuilds it. */
export async function collectSources(projectDirectory) {
  const paths = [
    ...SOURCE_FILES.map((file) => resolve(projectDirectory, file)).filter((path) => existsSync(path)),
    ...(await Promise.all(SOURCE_FOLDERS.map((folder) => filesUnder(resolve(projectDirectory, folder))))).flat(),
  ]
  const sources = {}
  let bytes = 0
  for (const path of paths) {
    const name = relative(projectDirectory, path).split(sep).join('/')
    if (!SOURCE_EXTENSIONS.has(extensionOf(path)) || TEMPLATE_FILES.has(name)) continue
    const text = await readFile(path, 'utf8')
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_SOURCES_BYTES) return null
    sources[name] = text
  }
  return sources
}

/** The manifest as the one block Solus reads from a page. Every `<` is escaped, so nothing in it can end the script element. */
export function appManifestBlock(manifest) {
  return `<script type="application/json" id="solus-app">${JSON.stringify(manifest).replace(/</g, '\\u003c')}</script>`
}

/** The app manifest of a project that has an app.json; null for a plain artifact. */
async function appManifestOf(projectDirectory, build) {
  const configPath = resolve(projectDirectory, 'app.json')
  if (!existsSync(configPath)) {
    if (SERVER_ENTRIES.some((entry) => existsSync(resolve(projectDirectory, entry)))) throw new Error('The project has a server.ts and no app.json. Add an app.json, even an empty {}, to make it an app.')
    return null
  }
  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`app.json is not JSON: ${error.message}`)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('app.json must be an object, such as {} or { "permissions": { … } }.')
  const manifest = { solusApp: 1, permissions: config.permissions ?? {}, integrations: [] }

  // The host's code, when the app has any: one CommonJS module for Node. Each exported function is a host function.
  const serverEntry = SERVER_ENTRIES.find((entry) => existsSync(resolve(projectDirectory, entry)))
  if (serverEntry) {
    const built = await build({
      absWorkingDir: projectDirectory,
      entryPoints: [serverEntry],
      outfile: 'server.js',
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: ['node22'],
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      // A native add-on cannot load in an app's runner; fail here, not at the first call.
      plugins: [{
        name: 'solus-app-no-native-addons',
        setup(builder) {
          builder.onLoad({ filter: /\.node$/ }, ({ path }) => ({ errors: [{ text: `A host function cannot load a native add-on (${path}). Use a package written in JavaScript, or a Node built-in such as node:sqlite.` }] }))
        },
      }],
    })
    if (built.outputFiles.length !== 1) throw new Error('Expected one server bundle.')
    manifest.server = built.outputFiles[0].text
  }

  const sources = await collectSources(projectDirectory)
  if (sources) manifest.sources = sources
  else console.warn(`The sources are over ${MAX_SOURCES_BYTES / 1024} KiB, so the app does not carry them. Keep this project folder to revise the app.`)
  const pageCode = Object.entries(sources ?? {}).filter(([path]) => path.startsWith('src/') && CODE_EXTENSIONS.has(extensionOf(path))).map(([, text]) => text).join('\n')
  manifest.integrations = integrationsOf(pageCode)
  return manifest
}

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
  const page = assembleHtml(shell, scripts[0].text, styles[0]?.text ?? '')
  const manifest = await appManifestOf(projectDirectory, build)
  // The manifest is the last thing in the page, so the page's own markup reads the same with or without it.
  const html = manifest ? `${page}\n${appManifestBlock(manifest)}\n` : page
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
  return { output, bytes, manifest }
}

// Compare real paths: the skill is often reached through a symlink (~/.solus/plugins),
// and a mismatch would skip the command without a word.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 3) {
    console.error('Usage: node bundle-artifact.mjs [artifact-directory]')
    process.exitCode = 1
  } else {
    try {
      const { output, bytes, manifest } = await bundleArtifact(process.argv[2] ?? process.cwd())
      console.log(`Artifact ready: ${output} (${Math.ceil(bytes / 1024)} KiB)`)
      if (manifest) {
        console.log(manifest.server ? 'It is an app with host functions: the user must allow its host access before they run.' : 'It is an app with no host functions.')
        if (manifest.integrations.length) console.log(`It names these integrations: ${manifest.integrations.join(', ')}.`)
        console.log('Check it with create_app preview: true, then save it with create_app.')
      }
    } catch (error) {
      console.error(`Artifact bundle failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
