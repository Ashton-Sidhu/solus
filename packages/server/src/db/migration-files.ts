import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type MigrationDialect = 'sqlite' | 'postgres'

/**
 * Where the generated Drizzle migrations for one engine live at runtime.
 *
 * drizzle-kit writes them to `packages/server/drizzle/<dialect>`; the main
 * build copies that folder beside the bundle as `dist/main/drizzle`. Rollup
 * decides whether this module lands in the bundle entry or in `chunks/`, so
 * both bundle-relative spellings are tried before the source tree's.
 */
export function migrationsFolder(dialect: MigrationDialect): string {
  const candidates = [
    join(__dirname, 'drizzle'),
    join(__dirname, '..', 'drizzle'),
    join(__dirname, '..', '..', 'drizzle'),
  ]
  for (const candidate of candidates) {
    const folder = join(candidate, dialect)
    if (existsSync(join(folder, 'meta', '_journal.json'))) return folder
  }
  throw new Error(`No ${dialect} migrations found beside ${__dirname}.`)
}
