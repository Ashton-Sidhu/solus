import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { appDescriptorSchema, type AppDescriptor } from '@solus/contracts/apps'
import { z } from 'zod'
import type { AppFile } from './app-repository'

/**
 * An app project as a deploy reads it (docs/plans/apps.md §3): the build that
 * `npm run bundle` wrote into `dist/app/`, and the project's own files, which
 * become the source commit.
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
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', '.artifact', '.cache', '.turbo'])
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
  if (descriptorText === null) throw new AppProjectError(`This folder has no app build: ${APP_BUILD_FOLDER}/${DESCRIPTOR_FILE} is missing. Run \`npm run bundle\` in the app project, which needs an app.ts.`)
  let descriptorJson: z.infer<ReturnType<typeof z.json>>
  try {
    descriptorJson = z.json().parse(JSON.parse(descriptorText))
  } catch {
    throw new AppProjectError('The descriptor is not JSON. Run `npm run bundle` again.')
  }
  const descriptor = appDescriptorSchema.safeParse(descriptorJson)
  if (!descriptor.success) throw new AppProjectError(`The descriptor is not valid: ${z.prettifyError(descriptor.error)}`)
  const backend = await readOptional(join(folder, BACKEND_FILE), MAX_BACKEND_BYTES, 'The backend module')
  const ui = await readOptional(join(folder, UI_FILE), MAX_UI_BYTES, 'The UI')
  if (descriptor.data.operations.length > 0 && backend === null) throw new AppProjectError(`The descriptor declares operations, and ${APP_BUILD_FOLDER}/${BACKEND_FILE} is missing. Run \`npm run bundle\` again.`)
  if (backend === null && ui === null) throw new AppProjectError('This app has no UI and no operation. Add a UI in src/, or an operation in app.ts.')
  return { descriptor: descriptor.data, backend, ui, migrations: await readMigrations(join(folder, MIGRATIONS_FOLDER)) }
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
