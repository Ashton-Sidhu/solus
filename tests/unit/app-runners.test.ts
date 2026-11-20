import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppLogLine, AppPermissions, AppSpan } from '@solus/contracts/apps'
import { AppRunners, runnerArguments, type AppRun, type AppRunnerCall, type AppRunnerHost, type AppRunnerStep, type AppRunnerWorkflow } from '@solus/server/apps/app-runners'

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
const op = (handler, extra = {}) => ({ input: pass, handler, ...extra })
const refuse = (message) => ({ safeParse: () => ({ success: false, error: { issues: [{ path: ['total'], message }] } }) })
class NonRetryableError extends Error { constructor(message) { super(message); this.name = 'NonRetryableError' } }
let flaky = 0
exports.default = { operations: {
  echo: op((ctx, input) => ({ input, files: ctx.files.dir, caller: ctx.caller, secret: ctx.secrets.token ?? null })),
  read: op((ctx, { file }) => fs.readFileSync(file, 'utf8')),
  keep: op((ctx, { text }) => { fs.writeFileSync(path.join(ctx.files.dir, 'kept.txt'), text); return 'kept' }),
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
  chatty: op(async (ctx, { url }) => { console.log('started', { n: 1 }); console.warn('careful'); ctx.sql.exec('SELECT n FROM numbers'); ctx.sql.exec('SELECT n FROM numbers'); if (url) await fetch(url); return 'done' }),
  shaped: op(() => ({ total: 'three' }), { output: refuse('Expected a number') }),
  fileWrite: op(async (ctx, { text }) => { const file = await ctx.files.write('note.txt', text, 'text/plain'); return { file, text: await ctx.files.text(file.id), path: ctx.files.path(file.id) } }),
  fileWriteInQuery: op((ctx) => ctx.files.write('no.txt', 'x')),
  announce: op((ctx, { fail }) => { ctx.signals.emit('note.saved', { id: 7 }); if (fail) throw new Error('after the signal'); return 'said' }),
  announceUnknown: op((ctx) => ctx.signals.emit('note.lost', {})),
  announceInQuery: op((ctx) => ctx.signals.emit('note.saved', { id: 1 })),
  begin: op((ctx, input) => ctx.workflows.start('report', input, { key: 'k1' })),
  beginInQuery: op((ctx) => ctx.workflows.start('report', {})),
}, signals: { 'note.saved': { payload: pass } }, workflows: {
  report: { input: pass, handler: async (ctx, input) => {
    const fetched = await ctx.step.do('fetch', async (step) => { console.log('fetching', step.attempt); return { rows: input.rows, key: step.idempotencyKey } })
    const saved = await ctx.step.runMutation('save', 'insert', { n: fetched.rows })
    return { fetched, saved, run: ctx.runId }
  } },
  retried: { input: pass, handler: (ctx) => ctx.step.do('flaky', { retries: { limit: 3, delay: 1 } }, (step) => { flaky += 1; if (step.attempt < 3) throw new Error('not yet'); step.signals.emit('note.saved', { id: step.attempt }); return { attempt: step.attempt, ran: flaky } }) },
  hopeless: { input: pass, handler: (ctx) => ctx.step.do('never', { retries: { limit: 5, delay: 1 } }, () => { throw new NonRetryableError('wrong for good') }) },
  slow: { input: pass, handler: (ctx) => ctx.step.do('slow', { timeout: 50 }, () => new Promise(() => {})) },
  napping: { input: pass, handler: async (ctx) => { await ctx.step.sleep('short', 20); await ctx.step.sleep('long', '2 hours'); return 'awake' } },
  twice: { input: pass, handler: async (ctx) => { await ctx.step.do('same', () => 1); await ctx.step.do('same', () => 2) } },
} }
`
const OPERATIONS: AppRun['operations'] = [
  ...['echo', 'read', 'shell', 'get', 'open', 'fail', 'hang', 'big', 'rows', 'issues', 'chatty', 'shaped', 'fileWriteInQuery', 'announceInQuery', 'beginInQuery'].map((name) => ({ name, kind: 'query' as const })),
  ...['keep', 'write', 'insert', 'insertThenFail', 'both', 'awaited', 'fileWrite', 'announce', 'announceUnknown', 'begin'].map((name) => ({ name, kind: 'mutation' as const })),
]
const WORKFLOWS = ['report', 'retried', 'hopeless', 'slow', 'napping', 'twice']
const MIGRATIONS = [{ name: '0001_numbers.sql', sql: 'CREATE TABLE numbers (n INTEGER PRIMARY KEY);' }]

const permissions = (extra: Partial<AppPermissions> = {}): AppPermissions => ({ network: [], files: { read: [], write: [] }, ...extra })

let appCount = 0
/** A run in a data folder of its own, so one test's database is not another's. */
function run(extra: Partial<AppRun> = {}): AppRun {
  const appFolder = join(root, `app-${appCount++}`)
  const filesDir = join(appFolder, 'files')
  mkdirSync(filesDir, { recursive: true })
  return { appId: `app-${appCount}`, signature: '1', code: BACKEND, protocol: 3, permissions: permissions(), appFolder, filesDir, secrets: {}, migrations: MIGRATIONS, operations: OPERATIONS, workflows: WORKFLOWS, ...extra }
}

/** What a call asked its host, and what it said while it ran. */
interface Heard {
  requests: { method: string; input: unknown }[]
  logs: AppLogLine[]
  spans: AppSpan[]
}

/** A host that keeps what it hears and answers each request with `answer`. */
function hearing(answer: (method: string, input: unknown) => unknown = () => { throw new Error('This test asks the host for nothing.') }): { host: AppRunnerHost; heard: Heard } {
  const heard: Heard = { requests: [], logs: [], spans: [] }
  return {
    heard,
    host: {
      log: (line) => heard.logs.push(line),
      span: (span) => heard.spans.push(span),
      request: async (method, input) => {
        heard.requests.push({ method, input })
        return JSON.parse(JSON.stringify((await answer(method, input)) ?? null))
      },
    },
  }
}

const call = (name: string, input: object = {}, host: AppRunnerHost = hearing().host): AppRunnerCall => ({ name, input: JSON.parse(JSON.stringify(input)), caller: { kind: 'ui' }, host })

/** A host for a run: it keeps each step's receipt as the workflows part does, and runs a step's operation in the same runner. */
function runHost(runners: AppRunners, started: AppRun, receipts: Map<string, AppRunnerStep> = new Map()): { host: AppRunnerHost; heard: Heard; receipts: Map<string, AppRunnerStep> } {
  const { host, heard } = hearing((method, input) => {
    // SAFETY: each request of a run has the fields its method names.
    const step = input as { name: string; attempt?: number; result?: never; wakeAt?: number; operation?: string; input?: object }
    const receipt = receipts.get(step.name) ?? { name: step.name, state: 'running' as const, result: null, attempts: 0, wakeAt: null }
    receipts.set(step.name, receipt)
    if (method === 'step.begin' || method === 'step.retry') receipt.attempts = step.attempt ?? receipt.attempts
    if (method === 'step.done') Object.assign(receipt, { state: 'done', result: step.result ?? null })
    if (method === 'step.fail') receipt.state = 'failed'
    if (method === 'step.sleep') Object.assign(receipt, { state: 'sleeping', wakeAt: step.wakeAt })
    if (method === 'step.op') {
      return runners.call(started, call(step.operation ?? '', step.input)).then((result) => {
        Object.assign(receipt, { state: 'done', result: result.value })
        return result.value
      })
    }
    return null
  })
  return { host, heard, receipts }
}

const workflow = (name: string, host: AppRunnerHost, steps: AppRunnerStep[] = [], input: object = {}): AppRunnerWorkflow => ({ workflow: name, runId: 'run-1', input: JSON.parse(JSON.stringify(input)), steps, host })

let runners: AppRunners | null = null
function start(options: { callTimeoutMs?: number } = {}): AppRunners {
  runners = new AppRunners(options)
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
      signals: [],
      suspended: false,
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
    expect(await runners.call(started, call('insert', { n: 1 }))).toMatchObject({ value: { n: 1 }, changed: true })
    expect(await runners.call(started, call('rows'))).toMatchObject({ value: [{ n: 1 }], changed: false })
    // The same folder with another signature is a new process: the migration is known, and the data is there.
    const again = { ...started, signature: '2', migrations: [...MIGRATIONS, { name: '0002_more.sql', sql: 'INSERT INTO numbers (n) VALUES (2);' }] }
    expect(await runners.start(again)).toEqual(['0002_more.sql'])
    expect((await runners.call(again, call('rows'))).value).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('the new migrations of a version apply whole or not at all', async () => {
    // WHY: each migration once committed by itself. When the third of three
    // failed, the version failed but the first two stayed, and the version
    // before it then ran on a schema that was half changed.
    const runners = start()
    const started = run({ migrations: [
      ...MIGRATIONS,
      { name: '0002_extra.sql', sql: 'CREATE TABLE extra (n INTEGER); INSERT INTO numbers (n) VALUES (5);' },
      { name: '0003_bad.sql', sql: 'INSERT INTO missing VALUES (1);' },
    ] })
    await expect(runners.start(started)).rejects.toThrow('The migration 0003_bad.sql failed')
    await expect(runners.start(started)).rejects.toThrow('Nothing was applied.')
    // Not one of the three is there: the same data takes the first migration again, from the start.
    expect(await runners.start({ ...started, signature: '2', migrations: MIGRATIONS })).toEqual(['0001_numbers.sql'])
    expect((await runners.call({ ...started, signature: '2', migrations: MIGRATIONS }, call('rows'))).value).toEqual([])
  })

  test('a version that edits, removes, or puts a migration before an applied one is refused, and applies nothing', async () => {
    // WHY: an edited migration was skipped with no message, because the host
    // knew a migration only by its name. The data then did not match the files.
    const runners = start()
    const started = run({ migrations: [...MIGRATIONS, { name: '0003_more.sql', sql: 'INSERT INTO numbers (n) VALUES (3);' }] })
    await runners.start(started)
    const next = (signature: string, migrations: AppRun['migrations']) => runners.start({ ...started, signature, migrations })
    await expect(next('edited', [{ name: '0001_numbers.sql', sql: 'CREATE TABLE numbers (n INTEGER PRIMARY KEY, extra TEXT);' }, started.migrations[1]!])).rejects.toThrow('The migration 0001_numbers.sql was changed after it was applied.')
    await expect(next('removed', [started.migrations[1]!, { name: '0004_new.sql', sql: 'INSERT INTO numbers (n) VALUES (4);' }])).rejects.toThrow('The migration 0001_numbers.sql was applied to this app\'s data, and this version does not have it.')
    await expect(next('before', [...started.migrations, { name: '0002_late.sql', sql: 'INSERT INTO numbers (n) VALUES (2);' }].sort((a, b) => a.name.localeCompare(b.name)))).rejects.toThrow('The migration 0002_late.sql is new, and 0003_more.sql was applied before it.')
    // None of the three refusals applied its new file.
    expect((await runners.call(started, call('rows'))).value).toEqual([{ n: 3 }])
    // An earlier version that is active again has fewer migrations than the data has seen: that is not a refusal.
    expect(await next('earlier', MIGRATIONS)).toEqual([])
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
    const { host, heard } = hearing(() => ['ENG-1'])
    const result = await start().call(run(), call('issues', { team: 'ENG' }, host))
    expect(result.value).toEqual(['ENG-1'])
    expect(heard.requests).toEqual([{ method: 'tool', input: { slug: 'linear', tool: 'list_issues', input: { team: 'ENG' } } }])
    expect(heard.spans).toEqual([expect.objectContaining({ kind: 'tool', name: 'linear.list_issues', ok: true })])
    await expect(start().call(run(), call('issues'))).rejects.toThrow('This test asks the host for nothing.')
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
    const first = run({ code: 'exports.default = { operations: { version: { handler: () => 1 } } }', operations: [{ name: 'version', kind: 'query' }], workflows: [] })
    expect((await runners.call(first, call('version'))).value).toBe(1)
    expect((await runners.call({ ...first, signature: '2', code: 'exports.default = { operations: { version: { handler: () => 2 } } }' }, call('version'))).value).toBe(2)
  })

  test('a build keeps the `ctx` of its protocol when the host has a newer one', async () => {
    // WHY (decision 22): the host makes `ctx`, not the build. In protocol 2
    // `ctx.files` is a path; in protocol 3 it is an object. A host update must
    // not change what a deployed build reads.
    const code = 'exports.default = { operations: { shape: { handler: (ctx) => ({ files: typeof ctx.files, signals: typeof ctx.signals, workflows: typeof ctx.workflows }) } } }'
    const base = { code, operations: [{ name: 'shape', kind: 'query' as const }], workflows: [], migrations: [] }
    const runners = start()
    expect((await runners.call(run({ ...base, protocol: 2 }), call('shape'))).value).toEqual({ files: 'string', signals: 'undefined', workflows: 'undefined' })
    expect((await runners.call(run({ ...base, protocol: 3 }), call('shape'))).value).toEqual({ files: 'object', signals: 'object', workflows: 'object' })
  })

  describe('what a call says while it runs', () => {
    let server: Server
    afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())))

    test('each log line and each span of a call reaches the host as it happens', async () => {
      // WHY: an agent that repairs an app had one error message. The log
      // lines and the trace say what the call did before it failed.
      const port = await new Promise<number>((resolve) => {
        server = createServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1', () => {
          // SAFETY: a server that listens on a port answers its address as an object.
          resolve((server.address() as AddressInfo).port)
        })
      })
      const { host, heard } = hearing()
      const started = run({ permissions: permissions({ network: [`127.0.0.1:${port}`] }) })
      await start().call(started, call('chatty', { url: `http://127.0.0.1:${port}/secret/path?token=1` }, host))
      expect(heard.logs.map((line) => [line.level, line.text])).toEqual([['log', 'started { n: 1 }'], ['warn', 'careful']])
      expect(heard.spans.map((span) => [span.kind, span.name, span.ok])).toEqual([['fetch', `GET 127.0.0.1:${port}`, true], ['sql', '2 statements', true]])
      // A span names the host of a request, never its path or its query.
      expect(JSON.stringify(heard.spans)).not.toContain('secret')
    })

    test('a call that the host stops for time keeps the lines it wrote before', async () => {
      const { host, heard } = hearing()
      const runners = start()
      const started = run({ code: 'exports.default = { operations: { stuck: { handler: () => { console.log("before the wait"); return new Promise(() => {}) } } } }', operations: [{ name: 'stuck', kind: 'query' }], workflows: [], migrations: [] })
      await expect(runners.call(started, { ...call('stuck', {}, host), timeoutMs: 200 })).rejects.toThrow('did not answer in 0 seconds')
      expect(heard.logs.map((line) => line.text)).toEqual(['before the wait'])
    })
  })

  test('a result that the output schema does not accept fails the call', async () => {
    await expect(start().call(run(), call('shaped'))).rejects.toThrow('The operation shaped returned a value that its output schema does not accept: total: Expected a number')
  })

  test('a mutation writes an app file and asks the host for its record; a query cannot', async () => {
    // WHY: the host owns the records of app files, so a file the backend
    // wrote shows in the UI and in the Files section like one a person gave.
    const { host, heard } = hearing((method, input) => (method === 'files.add' ? { ...(input as object), createdAt: 1 } : null))
    const started = run()
    const result = await start().call(started, call('fileWrite', { text: 'hello' }, host))
    const added = heard.requests.find((request) => request.method === 'files.add')?.input
    expect(added).toMatchObject({ name: 'note.txt', type: 'text/plain', size: 5 })
    expect(result.value).toMatchObject({ text: 'hello', file: { name: 'note.txt' } })
    // SAFETY: the operation answers the path it read.
    const path = (result.value as { path: string }).path
    expect(path.startsWith(join(started.appFolder, 'blobs'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('hello')
    await expect(start().call(run(), call('fileWriteInQuery'))).rejects.toThrow('A query cannot write an app file.')
  })

  test('a signal is kept only when its call succeeds, and only when the app declares it', async () => {
    // WHY: a signal can start agent work. A call that failed did not do what
    // the signal says, so nothing must hear of it.
    const runners = start()
    const started = run()
    expect((await runners.call(started, call('announce'))).signals).toEqual([{ name: 'note.saved', payload: { id: 7 } }])
    await expect(runners.call(started, call('announce', { fail: true }))).rejects.toThrow('after the signal')
    await expect(runners.call(started, call('announceUnknown'))).rejects.toThrow('This app declares no signal named note.lost.')
    await expect(runners.call(started, call('announceInQuery'))).rejects.toThrow('A query cannot emit a signal.')
  })

  test('a mutation starts a run through the host; a query cannot', async () => {
    const { host, heard } = hearing(() => ({ id: 'run-9', state: 'running' }))
    expect((await start().call(run(), call('begin', { rows: 2 }, host))).value).toEqual({ id: 'run-9', state: 'running' })
    expect(heard.requests).toEqual([{ method: 'workflows.start', input: { workflow: 'report', input: { rows: 2 }, key: 'k1' } }])
    await expect(start().call(run(), call('beginInQuery'))).rejects.toThrow('A query cannot start a workflow.')
  })

  describe('a workflow', () => {
    test('each step asks the host for its receipt, and a step\'s operation is a call of the app', async () => {
      const runners = start()
      const started = run()
      const { host, heard, receipts } = runHost(runners, started)
      const result = await runners.runWorkflow(started, workflow('report', host, [], { rows: 4 }))
      expect(result).toMatchObject({ suspended: false, value: { fetched: { rows: 4, key: 'run-1:fetch' }, saved: { n: 4 }, run: 'run-1' } })
      expect(heard.requests.map((request) => request.method)).toEqual(['step.begin', 'step.done', 'step.op'])
      expect([...receipts.values()].map((receipt) => [receipt.name, receipt.state])).toEqual([['fetch', 'done'], ['save', 'done']])
      // The lines a step writes are the run's, and each step is one span of its trace.
      expect(heard.logs.map((line) => line.text)).toEqual(['fetching 1'])
      expect(heard.spans.filter((span) => span.kind === 'step').map((span) => [span.name, span.ok])).toEqual([['fetch', true]])
      expect((await runners.call(started, call('rows'))).value).toEqual([{ n: 4 }])
    })

    test('a run that starts again answers each finished step from its receipt and does not do it again', async () => {
      // WHY: this is what makes a run durable. After a deploy, a stop, or a
      // restart of the host, the function runs from its top: a step that
      // finished must not fetch, write, or send a second time.
      const runners = start()
      const started = run()
      const first = runHost(runners, started)
      await runners.runWorkflow(started, workflow('report', first.host, [], { rows: 4 }))
      const again = runHost(runners, started, first.receipts)
      const result = await runners.runWorkflow(started, workflow('report', again.host, [...first.receipts.values()], { rows: 99 }))
      // The receipts answer, so the new input changes nothing and no step asks the host for anything.
      expect(result.value).toMatchObject({ fetched: { rows: 4 }, saved: { n: 4 } })
      expect(again.heard.requests).toEqual([])
      expect((await runners.call(started, call('rows'))).value).toEqual([{ n: 4 }])
    })

    test('a step that fails runs again up to its limit, and its signals are kept only for the attempt that succeeded', async () => {
      const runners = start()
      const started = run()
      const { host, heard } = runHost(runners, started)
      const result = await runners.runWorkflow(started, workflow('retried', host))
      expect(result.value).toEqual({ attempt: 3, ran: 3 })
      expect(heard.requests.map((request) => request.method)).toEqual(['step.begin', 'step.retry', 'step.begin', 'step.retry', 'step.begin', 'step.done'])
      expect(heard.requests.at(-1)?.input).toMatchObject({ name: 'flaky', signals: [{ id: 'run-1:flaky:0', name: 'note.saved', payload: { id: 3 } }] })
    })

    test('a run that starts again continues a step from the attempts it made', async () => {
      // WHY: a runner that stops between two attempts must not give the step its whole limit again.
      const runners = start()
      const started = run()
      const { host, heard } = runHost(runners, started)
      await runners.runWorkflow(started, workflow('retried', host, [{ name: 'flaky', state: 'running', result: null, attempts: 2, wakeAt: null }]))
      expect(heard.requests.map((request) => request.method)).toEqual(['step.begin', 'step.done'])
      expect(heard.requests[0]?.input).toMatchObject({ attempt: 3 })
    })

    test('a step that cannot succeed, a step out of time, and a step name used twice each fail the run with what happened', async () => {
      const runners = start()
      const started = run()
      const hopeless = runHost(runners, started)
      await expect(runners.runWorkflow(started, workflow('hopeless', hopeless.host))).rejects.toThrow('wrong for good')
      // No second attempt: the error says more attempts cannot help.
      expect(hopeless.heard.requests.map((request) => request.method)).toEqual(['step.begin', 'step.fail'])
      await expect(runners.runWorkflow(started, workflow('slow', runHost(runners, started).host))).rejects.toThrow('The step slow did not end in 0 seconds.')
      await expect(runners.runWorkflow(started, workflow('twice', runHost(runners, started).host))).rejects.toThrow('The step name same is used twice in this run.')
    })

    test('a short sleep waits in the runner, and a long sleep frees it until the host starts the run again', async () => {
      // WHY: a run that sleeps for hours must not hold a process, and it must
      // wake after the host restarts: the wake time is in the step's receipt.
      const runners = start()
      const started = run()
      const first = runHost(runners, started)
      const before = Date.now()
      const suspended = await runners.runWorkflow(started, workflow('napping', first.host))
      expect(suspended).toMatchObject({ suspended: true, value: null })
      expect(first.heard.requests.map((request) => request.method)).toEqual(['step.sleep', 'step.done', 'step.sleep'])
      const long = first.receipts.get('long')
      expect(long?.state).toBe('sleeping')
      expect((long?.wakeAt ?? 0) - before).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 1000)
      // The time came: the run starts again, the sleep answers from its receipt, and the function ends.
      const woken = runHost(runners, started, new Map([...first.receipts].map(([name, receipt]) => [name, { ...receipt, wakeAt: receipt.wakeAt === null ? null : Date.now() - 1 }])))
      expect(await runners.runWorkflow(started, workflow('napping', woken.host, [...woken.receipts.values()]))).toMatchObject({ suspended: false, value: 'awake' })
    })
  })
})
