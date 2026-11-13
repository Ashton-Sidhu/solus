import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AppBuildError, type AppBuilder, type AppBuildResult } from '@solus/server/apps/app-builder'
import { readAppBuild } from '@solus/server/apps/app-project'

/**
 * An app project as an agent writes it, and a builder that builds it as the
 * host's bundler does, made without npm: the backend is bundled by Bun from
 * the skill's own `@solus/app/backend` module, and the descriptor is what
 * that module answers. So a test saves and deploys what the skill's build
 * would write, and a change of the skill's module shows here.
 */

const ZOD_MODULE = createRequire(import.meta.url).resolve('zod')
const BACKEND_MODULE = resolve(import.meta.dir, '../../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend.ts')
/** The built UI of a test project: a source file the test builder copies, in place of a React build. */
const TEST_UI_FILE = 'ui.built.html'

export interface AppProjectFiles {
  /** The text of `app.ts`. It imports from `@solus/app/backend`. */
  app: string
  /** `migrations/<name>`: its SQL. */
  migrations?: { [name: string]: string }
  /** The built UI; omitted for an app with no UI. */
  ui?: string
  /** Other source files, by path from the project root. */
  source?: { [path: string]: string }
}

/** Writes the project's source into `folder`. Files of an earlier write that this one does not name go, but `.solus` stays: it says where the folder came from. */
export function writeAppProject(folder: string, files: AppProjectFiles): void {
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), text)
  }
  if (existsSync(folder)) for (const entry of readdirSync(folder)) if (entry !== '.solus') rmSync(join(folder, entry), { recursive: true, force: true })
  write('app.ts', files.app)
  write('package.json', '{ "name": "test-app" }')
  for (const [path, text] of Object.entries(files.source ?? {})) write(path, text)
  for (const [name, sql] of Object.entries(files.migrations ?? {})) write(`migrations/${name}`, sql)
  if (files.ui !== undefined) write(TEST_UI_FILE, files.ui)
}

/** Builds the project in `folder` into its `dist/app/`, as the host's bundler does. */
async function buildFolder(folder: string): Promise<AppBuildResult> {
  const startedAt = Date.now()
  const out = join(folder, 'dist', 'app')
  rmSync(join(folder, 'dist'), { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const entry = join(folder, '.test-entry.ts')
  // The folder has no node_modules: the two imports of an app.ts resolve to this repository's copies.
  writeFileSync(entry, readFileSync(join(folder, 'app.ts'), 'utf8').replaceAll("'@solus/app/backend'", JSON.stringify(BACKEND_MODULE)).replaceAll("'zod'", JSON.stringify(ZOD_MODULE)))
  const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'cjs', throw: false })
  rmSync(entry, { force: true })
  if (!built.success) {
    const log = built.logs.map(String).join('\n')
    throw new AppBuildError(`The build failed: ${log.split('\n').pop() ?? 'unknown'}`, log, Date.now() - startedAt)
  }
  const backend = join(out, 'backend.cjs')
  writeFileSync(backend, await built.outputs[0].text())
  const loaded = createRequire(backend)(backend)
  const descriptor = (loaded.default ?? loaded).descriptor()
  writeFileSync(join(out, 'descriptor.json'), JSON.stringify(descriptor))
  if (descriptor.operations.length === 0 && descriptor.workflows.length === 0) rmSync(backend)
  if (existsSync(join(folder, TEST_UI_FILE))) cpSync(join(folder, TEST_UI_FILE), join(out, 'ui.html'))
  if (existsSync(join(folder, 'migrations'))) cpSync(join(folder, 'migrations'), join(out, 'migrations'), { recursive: true })
  return { build: await readAppBuild(folder), log: 'Test build ready.\n', ms: Date.now() - startedAt }
}

/** A builder for tests: each revision is built in a new folder, with no install. It counts its builds. */
export function testAppBuilder(): AppBuilder & { revisionBuilds: number } {
  const folders: string[] = []
  return {
    revisionBuilds: 0,
    async buildRevision(_appId, checkout) {
      this.revisionBuilds += 1
      const folder = mkdtempSync(join(tmpdir(), 'solus-app-test-build-'))
      folders.push(folder)
      await checkout(folder)
      return buildFolder(folder)
    },
    buildProject: buildFolder,
    async remove() {
      for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
    },
  }
}
