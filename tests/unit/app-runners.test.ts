import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppPermissions } from '@solus/contracts/apps'
import { AppRunners, runnerArguments, type AppRun, type AppRunnerCall } from '@solus/server/apps/app-runners'

/**
 * An app's backend runs in a real Node under its permission model, so these
 * tests start one: Bun has no permission model and the runner refuses to load
 * an app without it. A machine with no Node 22 or later skips them.
 */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const hasNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22
const describeWithNode = hasNode ? describe : describe.skip

// The real path: the permission model compares the path a call names, and macOS reaches its temp folder through a link.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-app-runners-')))
const granted = join(root, 'granted')
const outside = join(root, 'outside')
for (const folder of [granted, outside]) mkdirSync(folder, { recursive: true })
writeFileSync(join(granted, 'in.txt'), 'inside')
writeFileSync(join(outside, 'out.txt'), 'outside')

/** A backend as the build writes it: a CommonJS module whose default export holds the operations. */
const BACKEND = `
const fs = require('node:fs')
const path = require('node:path')
const pass = { safeParse: (value) => ({ success: true, data: value }) }
const op = (handler) => ({ input: pass, handler })
exports.default = { operations: {
  echo: op((ctx, input) => ({ input, files: ctx.files, caller: ctx.caller, secret: ctx.secrets.token ?? null })),
  read: op((ctx, { file }) => fs.readFileSync(file, 'utf8')),
  keep: op((ctx, { text }) => { fs.writeFileSync(path.join(ctx.files, 'kept.txt'), text); return 'kept' }),
  write: op((ctx, { file }) => { fs.writeFileSync(file, 'x'); return 'written' }),
  shell: op(() => require('node:child_process').execSync('echo escaped').toString()),
  get: op(async (ctx, { url }) => (await fetch(url)).text()),
  open: op((ctx, { file, readOnly }) => { const { DatabaseSync } = require('node:sqlite'); (readOnly === undefined ? new DatabaseSync(file) : new DatabaseSync(file, { readOnly })).close(); return 'opened' }),
  fail: op(() => { throw new Error('the query is wrong') }),
  hang: op(() => new Promise(() => {})),
  big: op(() => 'x'.repeat(1100 * 1024)),
  rows: op((ctx) => ctx.sql.exec('SELECT n FROM numbers ORDER BY n').all()),
  insert: op((ctx, { n }) => ctx.sql.exec('INSERT INTO numbers (n) VALUES (?) RETURNING n', n).one()),
  insertThenFail: op((ctx, { n }) => { ctx.sql.exec('INSERT INTO numbers (n) VALUES (?)', n); throw new Error('after the write') }),
  both: op((ctx) => ctx.sql.transaction(() => { ctx.sql.exec('INSERT INTO numbers (n) VALUES (10)'); ctx.sql.exec('INSERT INTO numbers (n) VALUES (10)') })),
  awaited: op((ctx) => ctx.sql.transaction(async () => 1)),
  issues: op((ctx, input) => ctx.tools.linear.list_issues(input)),
} }
`
const OPERATIONS: AppRun['operations'] = [
  ...['echo', 'read', 'shell', 'get', 'open', 'fail', 'hang', 'big', 'rows', 'issues'].map((name) => ({ name, kind: 'query' as const })),
  ...['keep', 'write', 'insert', 'insertThenFail', 'both', 'awaited'].map((name) => ({ name, kind: 'mutation' as const })),
]
const MIGRATIONS = [{ name: '0001_numbers.sql', sql: 'CREATE TABLE numbers (n INTEGER PRIMARY KEY);' }]

const permissions = (extra: Partial<AppPermissions> = {}): AppPermissions => ({ network: [], files: { read: [], write: [] }, ...extra })

let appCount = 0
/** A run in a data folder of its own, so one test's database is not another's. */
function run(extra: Partial<AppRun> = {}): AppRun {
  const appFolder = join(root, `app-${appCount++}`)
  const filesDir = join(appFolder, 'files')
  mkdirSync(filesDir, { recursive: true })
  return { appId: `app-${appCount}`, signature: '1', code: BACKEND, permissions: permissions(), appFolder, filesDir, secrets: {}, migrations: MIGRATIONS, operations: OPERATIONS, ...extra }
}

const noTools: AppRunnerCall['tools'] = () => Promise.reject(new Error('This test calls no integration.'))
const call = (name: string, input: object = {}, tools = noTools): AppRunnerCall => ({ name, input: JSON.parse(JSON.stringify(input)), caller: { kind: 'ui' }, tools })

let runners: AppRunners | null = null
function start(options: { callTimeoutMs?: number } = {}): AppRunners {
  runners = new AppRunners({ node: 'node', ...options })
  return runners
}

afterEach(() => {
  runners?.dispose()
  runners = null
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('runner arguments', () => {
  test('the permission model gets the app\'s folder and its paths, a write path is also read, and the network flag goes only to a Node that has it', () => {
    const args = runnerArguments(permissions({ network: ['db.internal:5432'], files: { read: ['/srv/in'], write: ['/srv/out'] } }), '/data/app', true)
    expect(args.slice(0, 7)).toEqual(['--permission', '--allow-fs-read=/data/app', '--allow-fs-read=/srv/out', '--allow-fs-read=/srv/in', '--allow-fs-write=/data/app', '--allow-fs-write=/srv/out', '--allow-net'])
    // Node 24 does not know the flag and would not start with it.
    expect(runnerArguments(permissions({ network: ['*'] }), '/data/app', false)).not.toContain('--allow-net')
    // No network host: a Node with the network permission refuses every socket by itself.
    expect(runnerArguments(permissions(), '/data/app', true)).not.toContain('--allow-net')
  })
})

describeWithNode('an app\'s runner', () => {
  test('an operation gets its input, the app\'s files folder, its caller, and the secrets it declares', async () => {
    const started = run({ secrets: { token: 's3cret' } })
    const runners = start()
    expect(await runners.call(started, { ...call('echo', { table: 'users' }), caller: { kind: 'schedule', name: 'nightly' } })).toEqual({
      value: { input: { table: 'users' }, files: started.filesDir, caller: { kind: 'schedule', name: 'nightly' }, secret: 's3cret' },
      changed: false,
    })
    expect((await runners.call(started, call('keep', { text: 'mine' }))).value).toBe('kept')
    expect(readFileSync(join(started.filesDir, 'kept.txt'), 'utf8')).toBe('mine')
  })

  test('a start applies the migrations once, and a mutation says when it changed the data', async () => {
    // WHY: the host tells open UIs to read again only when the data changed,
    // and a second start must not run a migration that already ran.
    const started = run()
    const runners = start()
    expect(await runners.start(started)).toEqual(['0001_numbers.sql'])
    expect(await runners.call(started, call('insert', { n: 1 }))).toEqual({ value: { n: 1 }, changed: true })
    expect(await runners.call(started, call('rows'))).toEqual({ value: [{ n: 1 }], changed: false })
    // The same folder with another signature is a new process: the migration is known, and the data is there.
    const again = { ...started, signature: '2', migrations: [...MIGRATIONS, { name: '0002_more.sql', sql: 'INSERT INTO numbers (n) VALUES (2);' }] }
    expect(await runners.start(again)).toEqual(['0002_more.sql'])
    expect((await runners.call(again, call('rows'))).value).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('a migration that fails stops the start and leaves no part of itself', async () => {
    const started = run({ migrations: [...MIGRATIONS, { name: '0002_bad.sql', sql: 'INSERT INTO numbers (n) VALUES (5); INSERT INTO missing VALUES (1);' }] })
    const runners = start()
    await expect(runners.start(started)).rejects.toThrow('The migration 0002_bad.sql failed')
    expect((await runners.call({ ...started, signature: '2', migrations: MIGRATIONS }, call('rows'))).value).toEqual([])
  })

  test('a transaction commits all of its statements or none, and a mutation that fails after a write still says it changed the data', async () => {
    const started = run()
    const runners = start()
    await expect(runners.call(started, call('both'))).rejects.toThrow()
    expect((await runners.call(started, call('rows'))).value).toEqual([])
    await expect(runners.call(started, call('awaited'))).rejects.toThrow('A transaction is synchronous')
    await expect(runners.call(started, call('insertThenFail', { n: 3 }))).rejects.toMatchObject({ message: 'after the write', changed: true })
    expect((await runners.call(started, call('rows'))).value).toEqual([{ n: 3 }])
  })

  test('the kind in the descriptor decides the database: a mutation declared as a query cannot write', async () => {
    // WHY: an agent's session treats a query as a read. The host holds the code to what the descriptor says.
    const started = run({ operations: OPERATIONS.map((operation) => (operation.name === 'insert' ? { name: 'insert', kind: 'query' as const } : operation)) })
    await expect(start().call(started, call('insert', { n: 1 }))).rejects.toThrow(/readonly|read-only/i)
  })

  test('an integration call goes to the host, which answers it for that call', async () => {
    const asked: object[] = []
    const result = await start().call(run(), call('issues', { team: 'ENG' }, async (slug, tool, input) => {
      asked.push({ slug, tool, input })
      return ['ENG-1']
    }))
    expect(result.value).toEqual(['ENG-1'])
    expect(asked).toEqual([{ slug: 'linear', tool: 'list_issues', input: { team: 'ENG' } }])
    await expect(start().call(run(), call('issues'))).rejects.toThrow('This test calls no integration.')
  })

  test('the file system is the app\'s own folder and the paths its permissions name, and nothing else', async () => {
    // WHY: the app says what it uses, and its header shows that. Code that
    // reads or writes outside it would make the header false.
    const runners = start()
    const withPaths = run({ permissions: permissions({ files: { read: [granted], write: [] } }) })
    expect((await runners.call(withPaths, call('read', { file: join(granted, 'in.txt') }))).value).toBe('inside')
    await expect(runners.call(withPaths, call('read', { file: join(outside, 'out.txt') }))).rejects.toThrow(`not allowed to use FileSystemRead on ${join(outside, 'out.txt')}`)
    // A path it may read is not a path it may write.
    await expect(runners.call(withPaths, call('write', { file: join(granted, 'new.txt') }))).rejects.toThrow()
    expect(existsSync(join(granted, 'new.txt'))).toBe(false)
  })

  test('an operation cannot start a process', async () => {
    await expect(start().call(run(), call('shell'))).rejects.toThrow()
  })

  test('node:sqlite opens only a path the permissions name', async () => {
    // WHY: node:sqlite does not ask the permission model, so the runner checks the path itself.
    const runners = start()
    const withPaths = run({ permissions: permissions({ files: { read: [granted], write: [] } }) })
    await expect(runners.call(withPaths, call('open', { file: join(outside, 'other.db'), readOnly: false }))).rejects.toThrow('not allowed to read')
    expect(existsSync(join(outside, 'other.db'))).toBe(false)
    await expect(runners.call(withPaths, call('open', { file: join(granted, 'new.db'), readOnly: false }))).rejects.toThrow('readOnly')
    expect((await runners.call(withPaths, call('open', { file: join(withPaths.filesDir, 'own.db') }))).value).toBe('opened')
  })

  describe('network', () => {
    let server: Server
    let port = 0
    const listen = () => new Promise<void>((resolve) => {
      server = createServer((_request, response) => response.end('reached')).listen(0, '127.0.0.1', () => {
        // SAFETY: a server that listens on a port answers its address as an object.
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

    test('an operation reaches a host the permissions name and no other', async () => {
      // WHY: the desktop app's Node has no network permission, so the check in
      // the runner is the only thing between an app and every host.
      await listen()
      const runners = start()
      const url = `http://127.0.0.1:${port}/`
      await expect(runners.call(run(), call('get', { url }))).rejects.toThrow()
      await expect(runners.call(run({ permissions: permissions({ network: ['example.com'] }) }), call('get', { url }))).rejects.toThrow('not allowed to reach 127.0.0.1')
      await expect(runners.call(run({ permissions: permissions({ network: ['127.0.0.1:1'] }) }), call('get', { url }))).rejects.toThrow('not allowed to reach')
      expect((await runners.call(run({ permissions: permissions({ network: [`127.0.0.1:${port}`] }) }), call('get', { url }))).value).toBe('reached')
      expect((await runners.call(run({ permissions: permissions({ network: ['*'] }) }), call('get', { url }))).value).toBe('reached')
    })
  })

  test('an operation that throws, a name the app does not have, a result that is too large, and code that does not load each say what happened', async () => {
    const runners = start()
    const started = run()
    await expect(runners.call(started, call('fail'))).rejects.toThrow('the query is wrong')
    await expect(runners.call(started, call('missing'))).rejects.toThrow('This app has no operation named missing.')
    await expect(runners.call(started, call('big'))).rejects.toThrow('The result is over 1 MiB')
    await expect(runners.call(run({ code: 'this is not javascript' }), call('echo'))).rejects.toThrow()
    // A descriptor that names an operation the backend does not define is a build that does not match its code.
    await expect(runners.call(run({ operations: [...OPERATIONS, { name: 'ghost', kind: 'query' }] }), call('echo'))).rejects.toThrow('The backend does not define ghost')
  })

  test('an operation that never answers fails its call and does not hold the next one', async () => {
    const runners = start({ callTimeoutMs: 300 })
    const started = run()
    await expect(runners.call(started, call('hang'))).rejects.toThrow('did not answer')
    expect((await runners.call(started, call('echo'))).value).toMatchObject({ input: {} })
  })

  test('another signature runs the new code, not the process of the old one', async () => {
    const runners = start()
    const first = run({ code: 'exports.default = { operations: { version: { handler: () => 1 } } }', operations: [{ name: 'version', kind: 'query' }] })
    expect((await runners.call(first, call('version'))).value).toBe(1)
    expect((await runners.call({ ...first, signature: '2', code: 'exports.default = { operations: { version: { handler: () => 2 } } }' }, call('version'))).value).toBe(2)
  })
})
