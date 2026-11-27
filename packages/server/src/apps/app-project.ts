import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_ICON_FILE, APP_MENU_BAR_FILE, APP_PROTOCOLS, appDescriptorSchema, type AppDescriptor } from '@solus/contracts/apps'
import { z } from 'zod'
import { appIconProblem } from './app-icon'
import type { AppFile } from './app-repository'

/**
 * An app project as the host reads it (docs/plans/apps.md §3): its own files,
 * which a save commits as a revision; where it came from (`.solus/app.json`);
 * and the build that the bundler wrote into `dist/app/` of a build folder.
 */

/** Where a build is in a project. */
export const APP_BUILD_FOLDER = 'dist/app'
export const DESCRIPTOR_FILE = 'descriptor.json'
export const BACKEND_FILE = 'backend.cjs'
export const UI_FILE = 'ui.html'
export const MIGRATIONS_FOLDER = 'migrations'

const MAX_UI_BYTES = 8 * 1024 * 1024
const MAX_BACKEND_BYTES = 8 * 1024 * 1024
const MAX_MIGRATION_BYTES = 1024 * 1024
const MAX_MIGRATIONS = 500
const MAX_SOURCE_FILES = 2000
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024
const MAX_SOURCE_BYTES = 32 * 1024 * 1024

/** Folders that are never source: what a tool installed or built. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', '.artifact', '.cache', '.turbo', '.solus'])
const SKIPPED_FILES = new Set(['bundle.html', '.DS_Store'])

/** A migration's name: four digits, an underscore, a name, `.sql`. Its order is its number. */
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/

export interface AppMigration {
  name: string
  sql: string
}

/** One build: what a version runs. */
export interface AppBuild {
  descriptor: AppDescriptor
  /** The backend module, CommonJS for Node; null when the app declares no operation. */
  backend: string | null
  /** The UI, one built HTML file; null when the app has none. */
  ui: string | null
  /** The menu-bar page, one built HTML file (`menubar.html`); null when the app has none. */
  menuBar: string | null
  /** The project's `icon.svg`, checked; null when it has none and the tile is the monogram. */
  icon: string | null
  migrations: AppMigration[]
}

export class AppProjectError extends Error {}

async function readOptional(path: string, limit: number, what: string): Promise<string | null> {
  const size = await stat(path).then((entry) => (entry.isFile() ? entry.size : null), () => null)
  if (size === null) return null
  if (size > limit) throw new AppProjectError(`${what} is ${Math.ceil(size / 1024 / 1024)} MiB. The limit is ${limit / 1024 / 1024} MiB.`)
  return readFile(path, 'utf8')
}

/** The build of a project, checked: the descriptor is valid, and its parts agree with the files. */
export async function readAppBuild(project: string): Promise<AppBuild> {
  const folder = join(project, APP_BUILD_FOLDER)
  const descriptorText = await readOptional(join(folder, DESCRIPTOR_FILE), MAX_BACKEND_BYTES, 'The descriptor')
  if (descriptorText === null) throw new AppProjectError(`The build wrote no ${APP_BUILD_FOLDER}/${DESCRIPTOR_FILE}. An app project needs an app.ts next to package.json.`)
  let descriptorJson: z.infer<ReturnType<typeof z.json>>
  try {
    descriptorJson = z.json().parse(JSON.parse(descriptorText))
  } catch {
    throw new AppProjectError('The descriptor the build wrote is not JSON.')
  }
  const protocol = z.object({ solusApp: z.number() }).safeParse(descriptorJson)
  if (protocol.success && !APP_PROTOCOLS.some((known) => known === protocol.data.solusApp)) {
    throw new AppProjectError(`This build has protocol ${protocol.data.solusApp}. This host runs the protocols ${APP_PROTOCOLS.join(' and ')}. Update Solus on this host, or use the app template of this host's version.`)
  }
  const descriptor = appDescriptorSchema.safeParse(descriptorJson)
  if (!descriptor.success) throw new AppProjectError(`The descriptor is not valid: ${z.prettifyError(descriptor.error)}`)
  const backend = await readOptional(join(folder, BACKEND_FILE), MAX_BACKEND_BYTES, 'The backend module')
  const ui = await readOptional(join(folder, UI_FILE), MAX_UI_BYTES, 'The UI')
  const menuBar = await readOptional(join(folder, APP_MENU_BAR_FILE), MAX_UI_BYTES, 'The menu-bar page')
  if (menuBar !== null && ui === null) throw new AppProjectError('The build has a menu-bar page and no UI. A menu-bar page is a second page of an app with a UI.')
  if ((descriptor.data.operations.length > 0 || descriptor.data.workflows.length > 0) && backend === null) throw new AppProjectError(`The descriptor declares operations, and the build wrote no ${APP_BUILD_FOLDER}/${BACKEND_FILE}.`)
  if (backend === null && ui === null) throw new AppProjectError('This app has no UI and no operation. Add a UI in src/, or an operation in app.ts.')
  return { descriptor: descriptor.data, backend, ui, menuBar, icon: await readAppIcon(project), migrations: await readMigrations(join(folder, MIGRATIONS_FOLDER)) }
}

/** The project's icon, as the build keeps it. An icon that is not a plain, self-contained SVG stops the build with the reason. */
async function readAppIcon(project: string): Promise<string | null> {
  const path = join(project, APP_ICON_FILE)
  const isFile = await stat(path).then((entry) => entry.isFile(), () => false)
  if (!isFile) return null
  // A save keeps a source file to 2 MiB, so the read is small; the check refuses more than 64 KiB.
  const bytes = await readFile(path)
  checkAppIcon(bytes)
  return Buffer.from(bytes).toString('utf8')
}

/** Refuses an icon that is not a plain, self-contained SVG. A save and a build both check it. */
export function checkAppIcon(bytes: Uint8Array): void {
  const problem = appIconProblem(bytes)
  if (problem) throw new AppProjectError(problem)
}

async function readMigrations(folder: string): Promise<AppMigration[]> {
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith('.sql')).sort()
  if (names.length > MAX_MIGRATIONS) throw new AppProjectError(`An app has at most ${MAX_MIGRATIONS} migrations.`)
  const migrations: AppMigration[] = []
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) throw new AppProjectError(`The migration ${name} has a name Solus does not order. Name it as 0001_notes.sql: four digits, an underscore, lower-case letters, digits, and underscores.`)
    const sql = await readOptional(join(folder, name), MAX_MIGRATION_BYTES, `The migration ${name}`)
    if (sql !== null) migrations.push({ name, sql })
  }
  return migrations
}

/** The files of a build as its commit holds them. */
export function buildFiles(build: AppBuild): AppFile[] {
  const files: AppFile[] = [{ path: DESCRIPTOR_FILE, bytes: Buffer.from(JSON.stringify(build.descriptor)) }]
  if (build.backend !== null) files.push({ path: BACKEND_FILE, bytes: Buffer.from(build.backend) })
  if (build.ui !== null) files.push({ path: UI_FILE, bytes: Buffer.from(build.ui) })
  if (build.menuBar !== null) files.push({ path: APP_MENU_BAR_FILE, bytes: Buffer.from(build.menuBar) })
  if (build.icon !== null) files.push({ path: APP_ICON_FILE, bytes: Buffer.from(build.icon) })
  for (const migration of build.migrations) files.push({ path: `${MIGRATIONS_FOLDER}/${migration.name}`, bytes: Buffer.from(migration.sql) })
  return files
}

/** The project's own files, for the source commit: everything but what a tool installed or built. */
export async function readProjectSource(project: string): Promise<AppFile[]> {
  const files: AppFile[] = []
  let total = 0
  const walk = async (folder: string, prefix: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await walk(join(folder, entry.name), path)
        continue
      }
      if (!entry.isFile() || SKIPPED_FILES.has(entry.name)) continue
      const bytes = await readFile(join(folder, entry.name))
      if (bytes.length > MAX_SOURCE_FILE_BYTES) throw new AppProjectError(`${path} is over ${MAX_SOURCE_FILE_BYTES / 1024 / 1024} MiB. Keep large data out of the app project, or put it in the app's files folder.`)
      total += bytes.length
      if (files.length >= MAX_SOURCE_FILES || total > MAX_SOURCE_BYTES) throw new AppProjectError(`An app project holds at most ${MAX_SOURCE_FILES} files and ${MAX_SOURCE_BYTES / 1024 / 1024} MiB of source.`)
      files.push({ path, bytes })
    }
  }
  await walk(project, '')
  return files
}

// ─── Where a project came from (decision 7) ───

const ORIGIN_FILE = '.solus/app.json'

/** The app a project folder is for, and the revision its files came from; `revision` is null before the first save. */
export interface AppProjectOrigin {
  app: string
  revision: string | null
}

const originSchema = z.object({ app: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/).nullable() })

/** What `checkout_app` or the last `save_app` wrote into the project; null for a folder with no such file. */
export async function readProjectOrigin(project: string): Promise<AppProjectOrigin | null> {
  const text = await readFile(join(project, ORIGIN_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return originSchema.parse(JSON.parse(text))
  } catch {
    throw new AppProjectError(`${ORIGIN_FILE} of this project is not what Solus wrote. Delete it, and check the app out again into a new folder.`)
  }
}

export async function writeProjectOrigin(project: string, origin: AppProjectOrigin): Promise<void> {
  await mkdir(join(project, '.solus'), { recursive: true })
  await writeFile(join(project, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`)
}
