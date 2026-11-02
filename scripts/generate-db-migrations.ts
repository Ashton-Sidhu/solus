// Generate the one baseline migration of every database (docs/database-schema.md):
// `bun run db:generate`.
//
// There is no migration history. Each run empties the folder, lets drizzle-kit
// write `0000_baseline` from the schema module, and appends that database's
// hand-written SQL (FTS tables, triggers, tsvector columns) from
// packages/server/src/db/schema/custom/<schema>.sql.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..', 'packages', 'server')
const SCHEMAS = ['sqlite', 'postgres', 'metrics'] as const

for (const schema of SCHEMAS) {
  const out = join(serverDir, 'drizzle', schema)
  rmSync(out, { recursive: true, force: true })
  const result = spawnSync('bunx', ['drizzle-kit', 'generate', '--config', `drizzle.${schema}.config.ts`, '--name', 'baseline'], {
    cwd: serverDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  const custom = join(serverDir, 'src', 'db', 'schema', 'custom', `${schema}.sql`)
  if (!existsSync(custom)) continue
  const [baseline, ...rest] = readdirSync(out).filter((file) => file.endsWith('.sql'))
  if (!baseline || rest.length) throw new Error(`Expected one baseline in ${out}.`)
  appendFileSync(join(out, baseline), `\n--> statement-breakpoint\n${readFileSync(custom, 'utf8').trimEnd()}\n`)
}
