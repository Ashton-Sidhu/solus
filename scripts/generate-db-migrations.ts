// Generate the next migration of every database (docs/database-schema.md):
// `bun run db:generate --name <name>`.
//
// drizzle-kit compares each schema module with the last snapshot of its folder
// and writes `NNNN_<name>.sql` only for a database whose schema changed. SQL
// that `defineTable` cannot say (FTS5 tables, triggers, tsvector columns) goes in
// a custom migration: `bunx drizzle-kit generate --custom --config
// drizzle.<schema>.config.ts --name <name>` in packages/server, then write the
// SQL into the empty file it makes.
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..', 'packages', 'server')
const SCHEMAS = ['sqlite', 'postgres', 'metrics'] as const

const nameIndex = process.argv.indexOf('--name')
const name = nameIndex === -1 ? undefined : process.argv[nameIndex + 1]
if (!name || !/^[a-z0-9_-]+$/.test(name)) {
  console.error('Name the migration: bun run db:generate --name <name>, for example --name app_run_versions.')
  process.exit(1)
}

for (const schema of SCHEMAS) {
  const result = spawnSync('bunx', ['drizzle-kit', 'generate', '--config', `drizzle.${schema}.config.ts`, '--name', name], {
    cwd: serverDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Review each new file in ${join(serverDir, 'drizzle')}: a migration runs once on every database that exists.`)
