import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/**
 * An app project as `npm run bundle` leaves it, made without npm: the backend
 * is bundled by Bun from the skill's own `@solus/app/backend` module, and the
 * descriptor is what that module answers. So a test deploys what the skill's
 * build would write, and a change of the skill's module shows here.
 */

const ZOD_MODULE = createRequire(import.meta.url).resolve('zod')
const BACKEND_MODULE = resolve(import.meta.dir, '../../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend.ts')

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

/** Writes the project and its build into `folder`, replacing a build that is there. */
export async function writeAppProject(folder: string, files: AppProjectFiles): Promise<void> {
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), text)
  }
  rmSync(join(folder, 'dist'), { recursive: true, force: true })
  rmSync(join(folder, 'migrations'), { recursive: true, force: true })
  // The project has no node_modules: the two imports of an app.ts resolve to this repository's copies.
  write('app.ts', files.app.replaceAll("'@solus/app/backend'", JSON.stringify(BACKEND_MODULE)).replaceAll("'zod'", JSON.stringify(ZOD_MODULE)))
  write('package.json', '{ "name": "test-app" }')
  for (const [path, text] of Object.entries(files.source ?? {})) write(path, text)
  for (const [name, sql] of Object.entries(files.migrations ?? {})) {
    write(`migrations/${name}`, sql)
    write(`dist/app/migrations/${name}`, sql)
  }
  const built = await Bun.build({ entrypoints: [join(folder, 'app.ts')], target: 'node', format: 'cjs' })
  if (!built.success) throw new Error(`The test app did not build: ${built.logs.join('\n')}`)
  const code = await built.outputs[0].text()
  write('dist/app/backend.cjs', code)
  // The source commit holds `app.ts` as an agent writes it, not the path this helper resolved.
  write('app.ts', files.app)
  const loaded = createRequire(join(folder, 'dist/app/backend.cjs'))(join(folder, 'dist/app/backend.cjs'))
  const descriptor = (loaded.default ?? loaded).descriptor()
  write('dist/app/descriptor.json', JSON.stringify(descriptor))
  if (descriptor.operations.length === 0) rmSync(join(folder, 'dist/app/backend.cjs'))
  if (files.ui !== undefined) write('dist/app/ui.html', files.ui)
}
