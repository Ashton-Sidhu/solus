import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The four generated schemas: the host tables and the metrics file (SQLite on
 *  every machine), and the ported records on either engine. */
export type MigrationSchema = 'host' | 'sqlite' | 'postgres' | 'metrics'

/**
 * Where the generated Drizzle baseline of one schema lives at runtime.
 *
 * drizzle-kit writes it to `packages/server/drizzle/<schema>`; the main
 * build copies that folder beside the bundle as `dist/main/drizzle`. Rollup
 * decides whether this module lands in the bundle entry or in `chunks/`, so
 * both bundle-relative spellings are tried before the source tree's.
 */
export function migrationsFolder(schema: MigrationSchema): string {
  const candidates = [
    join(__dirname, 'drizzle'),
    join(__dirname, '..', 'drizzle'),
    join(__dirname, '..', '..', 'drizzle'),
  ]
  for (const candidate of candidates) {
    const folder = join(candidate, schema)
    if (existsSync(join(folder, 'meta', '_journal.json'))) return folder
  }
  throw new Error(`No ${schema} migrations found beside ${__dirname}.`)
}
