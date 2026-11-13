import { cp, mkdir, readFile, readdir, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// An app (references/apps.md): a project with an app.ts. The build then also
// writes the app's build into dist/app/: the descriptor (what the backend
// declares, as JSON), the backend bundled for Node, the UI, and a copy of the
// migrations. `deploy_app` reads that folder.

const APP_ENTRIES = ['app.ts', 'app.js']
const APP_BUILD_FOLDER = 'dist/app'

/** Asks the built backend what it declares, in a process of its own: loading it runs the app's top-level code. */
const DESCRIBE_SCRIPT = `
const loaded = require(process.argv[1])
const app = loaded && loaded.default ? loaded.default : loaded
if (!app || typeof app.descriptor !== 'function') {
  console.error('app.ts must export default defineApp({ ... }) from @solus/app/backend.')
  process.exit(2)
}
process.stdout.write(JSON.stringify({ descriptor: app.descriptor(), ui: app.ui !== false }))
`

/** The backend of a project that has an app.ts: its bundle, what it declares, and whether the app has a UI. Null for a plain artifact. */
async function buildBackend(projectDirectory, build) {
  const entry = APP_ENTRIES.find((name) => existsSync(resolve(projectDirectory, name)))
  if (!entry) return null
  const built = await build({
    absWorkingDir: projectDirectory,
    entryPoints: [entry],
    outfile: 'backend.cjs',
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
        builder.onLoad({ filter: /\.node$/ }, ({ path }) => ({ errors: [{ text: `An app's backend cannot load a native add-on (${path}). Use a package written in JavaScript, or a Node built-in such as node:sqlite.` }] }))
      },
    }],
  })
  if (built.outputFiles.length !== 1) throw new Error('Expected one backend bundle.')
  const code = built.outputFiles[0].text
  const folder = resolve(projectDirectory, APP_BUILD_FOLDER)
  await mkdir(folder, { recursive: true })
  const probe = resolve(folder, `.describe-${process.pid}.cjs`)
  try {
    await writeFile(probe, code)
    const described = JSON.parse(execFileSync(process.execPath, ['-e', DESCRIBE_SCRIPT, probe], { cwd: projectDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    return { code, descriptor: described.descriptor, ui: described.ui }
  } finally {
    await rm(probe, { force: true })
  }
}

async function writeAtomically(path, text) {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Writes dist/app/ whole: a file a build no longer makes must not stay from the build before it. */
async function writeAppBuild(projectDirectory, backend, html) {
  const folder = resolve(projectDirectory, APP_BUILD_FOLDER)
  const hasOperations = backend.descriptor.operations.length > 0
  await writeAtomically(resolve(folder, 'descriptor.json'), JSON.stringify(backend.descriptor, null, 1))
  if (hasOperations) await writeAtomically(resolve(folder, 'backend.cjs'), backend.code)
  else await rm(resolve(folder, 'backend.cjs'), { force: true })
  if (html !== null) await writeAtomically(resolve(folder, 'ui.html'), html)
  else await rm(resolve(folder, 'ui.html'), { force: true })
  const migrations = resolve(folder, 'migrations')
  await rm(migrations, { recursive: true, force: true })
  const source = resolve(projectDirectory, 'migrations')
  const names = (await readdir(source).catch(() => [])).filter((name) => name.endsWith('.sql')).sort()
  if (names.length > 0) await mkdir(migrations, { recursive: true })
  for (const name of names) await cp(resolve(source, name), resolve(migrations, name))
  return { folder, operations: backend.descriptor.operations.length, migrations: names.length, hasUi: html !== null }
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
  const backend = await buildBackend(projectDirectory, build)
  // An app with `ui: false` has no page: its operations are what an agent, a schedule, and a webhook call.
  if (backend && !backend.ui) return { output: null, bytes: 0, app: await writeAppBuild(projectDirectory, backend, null) }
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
  await writeAtomically(output, html)
  return { output, bytes, app: backend ? await writeAppBuild(projectDirectory, backend, html) : null }
}

// Compare real paths: the skill is often reached through a symlink (~/.solus/plugins),
// and a mismatch would skip the command without a word.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 3) {
    console.error('Usage: node bundle-artifact.mjs [artifact-directory]')
    process.exitCode = 1
  } else {
    try {
      const { output, bytes, app } = await bundleArtifact(process.argv[2] ?? process.cwd())
      if (output) console.log(`Artifact ready: ${output} (${Math.ceil(bytes / 1024)} KiB)`)
      if (app) {
        console.log(`App build ready: ${app.folder} (${app.operations} operation${app.operations === 1 ? '' : 's'}, ${app.migrations} migration${app.migrations === 1 ? '' : 's'}, ${app.hasUi ? 'with a UI' : 'no UI'}).`)
        console.log(app.hasUi ? 'Check it with preview_app and this folder as path, then deploy it with deploy_app.' : 'Deploy it with deploy_app and this folder as path.')
      }
    } catch (error) {
      console.error(`Artifact bundle failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
