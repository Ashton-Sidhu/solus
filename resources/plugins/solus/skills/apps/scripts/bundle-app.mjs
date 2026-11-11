import { readFile, readdir, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the Solus app shell provides at run time. The client bundle leaves exactly these to it, so an app and the shell share one React. */
export const SHELL_MODULES = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@tanstack/react-query', 'recharts', 'lucide-react', '@solus/app']

const SERVER_ENTRIES = ['server.ts', 'server.tsx', 'server.js', 'server/index.ts', 'server/index.js']
const SOURCE_FOLDERS = ['src', 'server']
const SOURCE_FILES = ['package.json', ...SERVER_ENTRIES.filter((entry) => !entry.includes('/'))]
/** Files every new project has from the template: a rebuilt project has them already. */
const TEMPLATE_FILES = new Set(['src/solus-app.d.ts', 'src/assets.d.ts'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md', '.sql', '.svg', '.txt'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MAX_SOURCES_BYTES = 512 * 1024
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

const extensionOf = (path) => (path.includes('.') ? path.slice(path.lastIndexOf('.')) : '')

/** Blanks comments, keeping length and newlines, so a commented-out `tools.github` is not an integration. */
function withCommentsBlanked(code) {
  return code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
}

const TOOLS_REFERENCE = /(?<![.\w$])tools\s*(?:\.\s*([A-Za-z_$][\w$-]*)|\[\s*(?:"([A-Za-z_$][\w$-]*)"|'([A-Za-z_$][\w$-]*)')\s*\])/g

/** The integration slugs the code reaches through `tools.<slug>`, first use first. The same rule as the Solus server's. */
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

/** The project's own text files, by path from the project root. A later session reads them from the saved app and rebuilds it. */
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

const ASSET_LOADERS = Object.fromEntries([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.webm',
].map((extension) => [extension, 'dataurl']))

export async function bundleApp(directory) {
  const projectDirectory = await realpath(resolve(directory))
  const require = createRequire(resolve(projectDirectory, 'package.json'))
  const { build } = require('esbuild')
  const typescriptManifest = require.resolve('typescript/package.json')
  const typescript = require('typescript/package.json')
  const typecheck = resolve(dirname(typescriptManifest), typescript.bin.tsc)
  execFileSync(process.execPath, [typecheck, '--noEmit', '--project', resolve(projectDirectory, 'tsconfig.json')], {
    cwd: projectDirectory,
    stdio: 'inherit',
  })

  // The frame's code: one CommonJS module body. The shell runs it with its own `require`.
  const client = await build({
    absWorkingDir: projectDirectory,
    entryPoints: ['src/App.tsx'],
    outfile: 'app.js',
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: SHELL_MODULES,
    loader: ASSET_LOADERS,
  })
  // Marking `react` external also marks `react/anything`. The shell answers only the names above.
  const unprovided = Object.values(client.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((dependency) => dependency.external && !dependency.path.startsWith('data:') && !SHELL_MODULES.includes(dependency.path))
    .map((dependency) => dependency.path)
  if (unprovided.length) throw new Error(`The Solus app shell does not provide: ${[...new Set(unprovided)].join(', ')}. It provides ${SHELL_MODULES.join(', ')}.`)
  const scripts = client.outputFiles.filter((file) => file.path.endsWith('.js'))
  const styles = client.outputFiles.filter((file) => file.path.endsWith('.css'))
  if (scripts.length !== 1 || styles.length > 1 || scripts.length + styles.length !== client.outputFiles.length) {
    throw new Error('Expected one JavaScript bundle and at most one stylesheet, with no separate assets or chunks.')
  }
  if (!/\bdefault\b/.test(scripts[0].text)) throw new Error('src/App.tsx must `export default` the app\'s React component.')

  // The host's code, when the app has any: one CommonJS module for Node. Each exported function is a host function.
  const serverEntry = SERVER_ENTRIES.find((entry) => existsSync(resolve(projectDirectory, entry)))
  let server
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
    server = built.outputFiles[0].text
  }

  const sources = await collectSources(projectDirectory)
  if (!sources) console.warn(`The sources are over ${MAX_SOURCES_BYTES / 1024} KiB, so the bundle does not carry them. Keep this project folder to revise the app.`)
  const integrations = integrationsOf(Object.entries(sources ?? {}).filter(([path]) => CODE_EXTENSIONS.has(extensionOf(path)) && path.startsWith('src/')).map(([, text]) => text).join('\n'))

  const bundle = { solusApp: 1, client: scripts[0].text, integrations }
  if (styles[0]?.text) bundle.css = styles[0].text
  if (server) bundle.server = server
  if (sources) bundle.sources = sources
  const json = JSON.stringify(bundle)
  const bytes = Buffer.byteLength(json)
  if (bytes > MAX_BUNDLE_BYTES) throw new Error('The app exceeds 8 MiB. Reduce data, assets, or dependencies.')
  const output = resolve(projectDirectory, 'app.bundle.json')
  const temporary = `${output}.${process.pid}.tmp`
  try {
    await writeFile(temporary, json, { flag: 'wx' })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return { output, bytes, hasServer: Boolean(server), integrations }
}

// Compare real paths: the skill is often reached through a symlink (~/.solus/plugins),
// and a mismatch would skip the command without a word.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 3) {
    console.error('Usage: node bundle-app.mjs [app-directory]')
    process.exitCode = 1
  } else {
    try {
      const { output, bytes, hasServer, integrations } = await bundleApp(process.argv[2] ?? process.cwd())
      console.log(`App ready: ${output} (${Math.ceil(bytes / 1024)} KiB)`)
      console.log(hasServer ? 'It has host functions: the user must allow its host access before they run.' : 'It has no host functions.')
      if (integrations.length) console.log(`It names these integrations: ${integrations.join(', ')}.`)
      console.log('Save it with create_app and bundle_path set to that file.')
    } catch (error) {
      console.error(`App bundle failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
