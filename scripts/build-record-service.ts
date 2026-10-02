import { cpSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { bundleServerEntry } from './package-server'

/**
 * Builds the record service the Solus Cloud application composes
 * (plans/013-unified-cloud-application.md §4):
 *
 *   bun scripts/build-record-service.ts --outdir <dir>
 *
 * Writes `<dir>/record-service.cjs`, which exports `createSolusApiService` and
 * `migrateSolusApiDatabase`, and `<dir>/drizzle`, the record migrations it reads
 * beside itself (packages/server/src/db/migration-files.ts). The bundle carries every
 * library it needs; only Node built-ins stay external. No execution runtime, agent
 * CLI, or browser is part of it (tests/unit/cloud-build-boundaries.test.ts).
 */

const repoRoot = resolve(import.meta.dir, '..')

function outdirOf(argv: string[]): string {
  const index = argv.indexOf('--outdir')
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw new Error('Usage: bun scripts/build-record-service.ts --outdir <dir>')
  return resolve(value)
}

async function main(): Promise<void> {
  const outdir = outdirOf(process.argv.slice(2))
  mkdirSync(outdir, { recursive: true })
  // A migration removed upstream must not survive from an earlier build.
  rmSync(join(outdir, 'drizzle'), { recursive: true, force: true })
  await bundleServerEntry(join(repoRoot, 'packages', 'server', 'src', 'boot-solus-api.ts'), join(outdir, 'record-service.cjs'))
  cpSync(join(repoRoot, 'packages', 'server', 'drizzle'), join(outdir, 'drizzle'), { recursive: true })
  console.log(`Record service at ${outdir}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
