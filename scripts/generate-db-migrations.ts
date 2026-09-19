// Generate the Drizzle migrations for both engines from the ported schema
// (docs/plans/cloud-service-model.md): `bun run db:generate [--name <tag>]`.
//
// drizzle-kit writes one migration per dialect under packages/server/drizzle/.
// The SQLite output is then made idempotent: a host's existing solus.db may
// already hold a ported table that the hand-written migrations created, and
// `CREATE TABLE IF NOT EXISTS` lets that file open without a rewrite.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..', 'packages', 'server')
const nameIndex = process.argv.indexOf('--name')
const name = nameIndex === -1 ? [] : ['--name', process.argv[nameIndex + 1] ?? 'schema']

for (const config of ['drizzle.sqlite.config.ts', 'drizzle.postgres.config.ts']) {
  const result = spawnSync('bunx', ['drizzle-kit', 'generate', '--config', config, ...name], {
    cwd: serverDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const sqliteFolder = join(serverDir, 'drizzle', 'sqlite')
for (const file of readdirSync(sqliteFolder)) {
  if (!file.endsWith('.sql')) continue
  const path = join(sqliteFolder, file)
  const patched = readFileSync(path, 'utf8')
    .replace(/^CREATE TABLE `/gm, 'CREATE TABLE IF NOT EXISTS `')
    .replace(/^CREATE INDEX `/gm, 'CREATE INDEX IF NOT EXISTS `')
    .replace(/^CREATE UNIQUE INDEX `/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS `')
  writeFileSync(path, patched)
}
