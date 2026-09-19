// A fresh process per file keeps module mocks separate. A deadline also stops
// a stuck Bun worker from using a CPU after the test command has ended.
//
// `--engine=postgres` runs every file against its own Postgres database
// (docs/plans/cloud-service-model.md): `POSTGRES_ADMIN_URL` names a server this
// runner may create databases on; each file gets one, and it is dropped after.
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import postgres from 'postgres'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const engineArg = args.find((arg) => arg.startsWith('--engine='))
const engine = engineArg ? engineArg.slice('--engine='.length) : 'sqlite'
if (engine !== 'sqlite' && engine !== 'postgres') throw new Error(`Unknown --engine "${engine}"; use sqlite or postgres.`)
const filters = args.filter((arg) => !arg.startsWith('--'))
const files = Array.from(new Bun.Glob('**/*.test.ts').scanSync({ cwd: join(root, 'tests/unit') }))
  .map((file) => `tests/unit/${file}`)
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort()
if (files.length === 0) throw new Error('No unit test files match the requested filters.')

const adminUrl = process.env.POSTGRES_ADMIN_URL
if (engine === 'postgres' && !adminUrl) throw new Error('--engine=postgres needs POSTGRES_ADMIN_URL, a server this runner may create databases on.')
const admin = engine === 'postgres' && adminUrl ? postgres(adminUrl, { max: 1, onnotice: () => {} }) : null
const runId = `${Date.now().toString(36)}_${process.pid}`
let nextDatabase = 0

/** One empty database for one test file, and the URL the file's server should open. */
async function createDatabase(): Promise<{ name: string; url: string }> {
  if (!admin || !adminUrl) throw new Error('No Postgres administration connection.')
  const name = `solus_test_${runId}_${nextDatabase++}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return { name, url: url.toString() }
}

async function dropDatabase(name: string): Promise<void> {
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
}

const active = new Map<ChildProcess, string>()
const startedAt = performance.now()
let nextFile = 0
let failed = 0
let completed = 0

function stop(child: ChildProcess): void {
  // These process groups belong only to children started by this runner.
  if (!child.pid) return
  if (process.platform === 'win32') child.kill('SIGKILL')
  else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const [child, directory] of active) {
      stop(child)
      rmSync(directory, { recursive: true, force: true })
    }
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

async function run(file: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'solus-unit-'))
  const logPath = join(directory, 'output.log')
  const output = openSync(logPath, 'w')
  const database = admin ? await createDatabase() : null
  const engineEnv = database
    ? { SOLUS_DB: 'postgres', DATABASE_URL: database.url }
    : { SOLUS_DB: 'sqlite', DATABASE_URL: '' }
  const child = spawn(process.execPath, ['test', '--no-orphans', file], {
    cwd: root,
    env: {
      ...process.env,
      ...engineEnv,
      SOLUS_DATA_DIR: join(directory, 'data'),
      // Bun 1.3.14 cached modules can fail to resolve the node:sqlite mock.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', output, output],
  })
  active.set(child, directory)
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    stop(child)
  }, 30_000)
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', resolveExit)
    })
    if (code !== 0 || timedOut) {
      failed++
      console.error(`\nFAIL ${file}${timedOut ? ' (30-second deadline exceeded)' : ''}`)
      console.error(readFileSync(logPath, 'utf8'))
    }
  } catch (error) {
    failed++
    console.error(`\nFAIL ${file}`, error)
  } finally {
    clearTimeout(deadline)
    stop(child)
    active.delete(child)
    closeSync(output)
    rmSync(directory, { recursive: true, force: true })
    if (database) await dropDatabase(database.name)
    completed++
    if (completed % 100 === 0) console.log(`Checked ${completed}/${files.length} files`)
  }
}

await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (nextFile < files.length) await run(files[nextFile++])
}))
await admin?.end()
console.log(`${files.length - failed} passed, ${failed} failed files on ${engine} (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`)
process.exitCode = failed > 0 ? 1 : 0
