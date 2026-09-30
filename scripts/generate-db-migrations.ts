// Generate the Drizzle migrations for both engines from the ported schema
// (docs/plans/cloud-service-model.md): `bun run db:generate [--name <tag>]`.
//
// drizzle-kit writes one migration per dialect under packages/server/drizzle/.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

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
