/**
 * The program an app's runner starts with (docs/plans/apps.md §6), passed to
 * Node as `-e`. It runs under Node's permission model, which confines the file
 * system module and refuses child processes, workers, and native add-ons. Two
 * things the permission model does not cover are checked here, before any
 * line of the app runs: the host of every socket, and the path `node:sqlite`
 * opens.
 *
 * It then opens the app's own database, applies the migrations the version
 * brings (whole or not at all, §4.3), loads the backend module, and runs its
 * operations and its workflows. A query gets the read-only connection,
 * whatever its code does: the kind comes from the descriptor the host holds,
 * not from the module. What `ctx` holds is the build's protocol (§6.3).
 *
 * The wire is one JSON object on each line. Requests arrive on stdin: `load`
 * once, then `call` for an operation, `run` for a workflow, and `reply` for
 * each `request` the runner made. Answers leave on stdout: `ready` or
 * `failed`, one `result` for each call and each run, `request` when the app
 * needs what the host owns (an integration tool, an app file's record, a
 * step's receipt, a workflow control), and `log` and `span` as they happen.
 * What the app prints outside a call goes to stderr.
 *
 * Plain JavaScript in a string, like the member file script: it must start on
 * the host's own Node with no file of its own to read.
 */
export const APP_RUNNER_SCRIPT = `'use strict'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')

if (!process.permission || typeof process.permission.has !== 'function') {
  send({ type: 'failed', message: 'This host cannot confine an app: its Node runtime has no permission model.' })
  process.exit(1)
}

const net = require('node:net')
const path = require('node:path')
const util = require('node:util')
const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const { fileURLToPath } = require('node:url')
const { AsyncLocalStorage } = require('node:async_hooks')
let network = []

// ── What runs now: one call or one run. Its log lines, spans, and signals belong to it. ──

const scope = new AsyncLocalStorage()

for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const text = util.format(...args)
    const current = scope.getStore()
    if (current) send({ type: 'log', call: current.id, level, atMs: Date.now() - current.startedAt, text: text.slice(0, 4000) })
    else process.stderr.write(text + '\\n')
  }
}

// \`attributes\` holds what the span says of itself with OpenTelemetry's names, where it has a convention.
// The host's tracer sends them as they are, so a collector reads an app's trace with no mapping.
function emitSpan(current, kind, name, startedAt, ok, detail, attributes) {
  if (!current) return
  const span = { type: 'span', call: current.id, kind, name: String(name).slice(0, 200), startMs: startedAt - current.startedAt, durationMs: Date.now() - startedAt, ok }
  if (detail !== undefined && detail !== null) span.detail = String(detail).slice(0, 300)
  if (attributes) span.attributes = attributes
  send(span)
}

function denied(what) {
  const error = new Error('This app is not allowed to ' + what + '. Its permissions in app.ts do not include it.')
  error.code = 'ERR_ACCESS_DENIED'
  return error
}

function admitsHost(host, port) {
  const name = String(host).toLowerCase()
  return network.some((entry) => {
    if (entry === '*') return true
    const at = entry.lastIndexOf(':')
    if (at > 0 && Number(entry.slice(at + 1)) !== Number(port)) return false
    const allowed = (at > 0 ? entry.slice(0, at) : entry).toLowerCase()
    return allowed.startsWith('*.') ? name.endsWith(allowed.slice(1)) : name === allowed
  })
}

// Every TCP and TLS connection, and so every HTTP request and fetch, starts here.
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  let target
  if (first !== null && typeof first === 'object') target = first.path !== undefined ? { path: first.path } : { host: first.host, port: first.port }
  else if (typeof first === 'string' && Number.isNaN(Number(first))) target = { path: first }
  else target = { host: typeof args[1] === 'string' ? args[1] : undefined, port: first }
  const allowed = target.path !== undefined ? network.includes('*') : admitsHost(target.host || 'localhost', target.port)
  if (allowed) return connect.apply(this, args)
  const error = denied('reach ' + (target.path !== undefined ? target.path : (target.host || 'localhost') + ':' + target.port))
  process.nextTick(() => this.destroy(error))
  return this
}

const dgram = require('node:dgram')
const createSocket = dgram.createSocket
dgram.createSocket = function (...args) {
  if (!network.includes('*')) throw denied('open a UDP socket')
  return createSocket.apply(this, args)
}

// Each request of a call is one span of its trace: the method and the host, never the path or a body.
const realFetch = globalThis.fetch
if (typeof realFetch === 'function') {
  globalThis.fetch = function (input, init) {
    const current = scope.getStore()
    if (!current) return realFetch.call(this, input, init)
    let name = 'fetch'
    // The HTTP conventions of OpenTelemetry: the method, the server, and the status. Never the path, the query, or a body.
    const attributes = {}
    try {
      const url = new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input))
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      name = method + ' ' + url.host
      attributes['http.request.method'] = method
      attributes['server.address'] = url.hostname
      attributes['server.port'] = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      attributes['url.scheme'] = url.protocol.replace(':', '')
    } catch {}
    const startedAt = Date.now()
    return realFetch.call(this, input, init).then(
      (response) => {
        attributes['http.response.status_code'] = response.status
        // A client span is an error from 400, as the conventions say.
        if (response.status >= 400) attributes['error.type'] = String(response.status)
        emitSpan(current, 'fetch', name, startedAt, response.status < 400, response.status, attributes)
        return response
      },
      (error) => {
        attributes['error.type'] = (error && (error.code || error.name)) || 'Error'
        emitSpan(current, 'fetch', name, startedAt, false, reason(error), attributes)
        throw error
      },
    )
  }
}

// node:sqlite opens a file without asking the permission model, so the path is checked here.
// The runner keeps the unchecked class for the app's own database.
let OwnDatabase = null
try {
  const sqlite = require('node:sqlite')
  const Database = sqlite.DatabaseSync
  OwnDatabase = Database
  sqlite.DatabaseSync = class DatabaseSync extends Database {
    constructor(location, ...rest) {
      const options = rest[0]
      let file = location instanceof URL ? fileURLToPath(location) : String(location)
      if (file !== '' && file !== ':memory:') {
        if (file.startsWith('file:')) file = fileURLToPath(file.split('?')[0])
        const resolved = path.resolve(file)
        if (!process.permission.has('fs.read', resolved)) throw denied('read ' + resolved)
        if (!(options && options.readOnly) && !process.permission.has('fs.write', resolved)) {
          throw denied('write ' + resolved + ' (open it with { readOnly: true }, or add the path to files.write)')
        }
      }
      super(location, ...rest)
    }
  }
} catch {
  // This Node has no node:sqlite. An app with migrations fails when it loads.
}
require('node:module').syncBuiltinESMExports()

function reason(error) {
  // Node's own refusal names a flag the person cannot set; say what the app's permissions lack.
  if (error && error.code === 'ERR_ACCESS_DENIED' && error.permission) {
    return 'This app is not allowed to use ' + error.permission + (error.resource ? ' on ' + error.resource : '') + '. Its permissions in app.ts do not include it.'
  }
  const message = error && error.message ? String(error.message) : String(error)
  const cause = error && error.cause && error.cause.message ? ': ' + error.cause.message : ''
  return message + cause
}

function stackOf(error) {
  return error && typeof error.stack === 'string' ? error.stack.slice(0, 8000) : null
}

function issuesText(error) {
  const issues = error && Array.isArray(error.issues) ? error.issues : []
  return issues.map((issue) => ((issue.path || []).join('.') || 'value') + ': ' + issue.message).join('; ')
}

// ── The app's own database ──

let writeDb = null
let readDb = null

function sqlFace(db, begin) {
  return Object.freeze({
    exec(text, ...values) {
      const current = scope.getStore()
      const startedAt = Date.now()
      try {
        const rows = db.prepare(String(text)).all(...values)
        return { all: () => rows, one: () => (rows.length > 0 ? rows[0] : null) }
      } finally {
        if (current) { current.sql.count += 1; current.sql.ms += Date.now() - startedAt }
      }
    },
    transaction(run) {
      db.exec(begin)
      try {
        const value = run()
        if (value && typeof value.then === 'function') throw new Error('A transaction is synchronous. Do not await inside it: do the network work first.')
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  })
}

const noDatabase = Object.freeze({
  exec() { throw new Error('This host\\'s Node has no node:sqlite, so this app has no database.') },
  transaction() { throw new Error('This host\\'s Node has no node:sqlite, so this app has no database.') },
})

// The migrations of a version apply whole or not at all (§4.3). A migration's name starts with four digits, so the order of the names is the order of the numbers.
function openDatabase(file, migrations) {
  if (!OwnDatabase) {
    if (migrations.length > 0) throw new Error('This host\\'s Node has no node:sqlite, so it cannot run an app with migrations.')
    return []
  }
  writeDb = new OwnDatabase(file)
  writeDb.exec('PRAGMA journal_mode = WAL')
  writeDb.exec('PRAGMA foreign_keys = ON')
  writeDb.exec('CREATE TABLE IF NOT EXISTS solus_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL, hash TEXT)')
  // A database from before the host kept hashes: each applied migration takes the hash of the file it has now.
  if (!writeDb.prepare('PRAGMA table_info(solus_migrations)').all().some((column) => column.name === 'hash')) writeDb.exec('ALTER TABLE solus_migrations ADD COLUMN hash TEXT')
  const applied = new Map(writeDb.prepare('SELECT name, hash FROM solus_migrations').all().map((row) => [row.name, row.hash]))
  const hashes = new Map(migrations.map((migration) => [migration.name, crypto.createHash('sha256').update(migration.sql).digest('hex')]))
  const lastInBuild = migrations.length > 0 ? migrations[migrations.length - 1].name : ''
  let lastApplied = ''
  const adopted = []
  for (const [name, hash] of applied) {
    if (name > lastApplied) lastApplied = name
    const now = hashes.get(name)
    if (now === undefined) {
      // An earlier version that is active again has fewer migrations than the data has seen.
      if (name < lastInBuild) throw new Error('The migration ' + name + ' was applied to this app\\'s data, and this version does not have it. Do not remove or rename a migration that was applied: add a new one. Nothing was applied.')
    } else if (!hash) adopted.push([name, now])
    else if (hash !== now) throw new Error('The migration ' + name + ' was changed after it was applied. Put it back as it was, and add a new migration for the change. Nothing was applied.')
  }
  const fresh = migrations.filter((migration) => !applied.has(migration.name))
  for (const migration of fresh) {
    if (migration.name < lastApplied) throw new Error('The migration ' + migration.name + ' is new, and ' + lastApplied + ' was applied before it. Give a new migration a number after every applied one. Nothing was applied.')
  }
  if (fresh.length > 0 || adopted.length > 0) {
    writeDb.exec('BEGIN IMMEDIATE')
    try {
      for (const [name, hash] of adopted) writeDb.prepare('UPDATE solus_migrations SET hash = ? WHERE name = ?').run(hash, name)
      for (const migration of fresh) {
        try {
          writeDb.exec(migration.sql)
        } catch (error) {
          throw new Error('The migration ' + migration.name + ' failed: ' + reason(error) + '. Nothing was applied.')
        }
        writeDb.prepare('INSERT INTO solus_migrations (name, applied_at, hash) VALUES (?, ?, ?)').run(migration.name, Date.now(), hashes.get(migration.name))
      }
      writeDb.exec('COMMIT')
    } catch (error) {
      try { writeDb.exec('ROLLBACK') } catch {}
      throw error
    }
  }
  readDb = new OwnDatabase(file, { readOnly: true })
  return fresh.map((migration) => migration.name)
}

function totalChanges() {
  return writeDb ? Number(writeDb.prepare('SELECT total_changes() AS n').get().n) : 0
}

// ── What the host owns: the runner asks, and the host replies ──

const waits = new Map()
let nextRequestId = 1

function ask(method, input) {
  const current = scope.getStore()
  return new Promise((resolve, reject) => {
    const id = nextRequestId++
    waits.set(id, { resolve, reject })
    send({ type: 'request', id, call: current ? current.id : null, method, input })
  })
}

function toolsFace() {
  return new Proxy({}, {
    get: (_target, slug) => new Proxy({}, {
      get: (_inner, tool) => (input) => {
        const current = scope.getStore()
        const startedAt = Date.now()
        // An integration tool is a tool of an MCP server: the names are the ones of those conventions.
        const attributes = { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': String(tool), integration: String(slug) }
        return ask('tool', { slug: String(slug), tool: String(tool), input: input === undefined ? {} : input }).then(
          (value) => { emitSpan(current, 'tool', String(slug) + '.' + String(tool), startedAt, true, undefined, attributes); return value },
          (error) => { emitSpan(current, 'tool', String(slug) + '.' + String(tool), startedAt, false, reason(error), attributes); throw error },
        )
      },
    }),
  })
}

// ── The backend ──

let protocol = 3
let operations = {}
let workflows = {}
let signals = {}
const kinds = new Map()
let base = { secrets: Object.freeze({}), config: Object.freeze({}), filesDir: '', blobsDir: '' }

function blobPath(id) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id))) throw new Error('This is not the id of an app file.')
  return path.join(base.blobsDir, String(id))
}

function filesFace(canWrite) {
  const spanned = (name, run) => {
    const current = scope.getStore()
    const startedAt = Date.now()
    return run().then(
      (value) => { emitSpan(current, 'file', name, startedAt, true); return value },
      (error) => { emitSpan(current, 'file', name, startedAt, false, reason(error)); throw error },
    )
  }
  return Object.freeze({
    dir: base.filesDir,
    list: () => ask('files.list', {}),
    get: (id) => ask('files.get', { id: String(id) }),
    path: blobPath,
    read: (id) => spanned('read', async () => new Uint8Array(await fsp.readFile(blobPath(id)))),
    text: (id) => spanned('read', () => fsp.readFile(blobPath(id), 'utf8')),
    write: (name, data, type) => spanned('write ' + String(name), async () => {
      if (!canWrite) throw new Error('A query cannot write an app file. Use a mutation.')
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      const id = crypto.randomUUID()
      await fsp.mkdir(base.blobsDir, { recursive: true })
      await fsp.writeFile(blobPath(id), bytes)
      try {
        return await ask('files.add', { id, name: String(name), type: type ? String(type) : '', size: bytes.length })
      } catch (error) {
        await fsp.rm(blobPath(id), { force: true })
        throw error
      }
    }),
    remove: (id) => spanned('remove', () => {
      if (!canWrite) return Promise.reject(new Error('A query cannot remove an app file. Use a mutation.'))
      return ask('files.remove', { id: String(id) })
    }),
  })
}

// An occurrence is kept only when the call or the step succeeds, so each one waits in \`kept\` until then.
function signalsFace(kept, canEmit) {
  return Object.freeze({
    emit(name, payload) {
      const current = scope.getStore()
      const startedAt = Date.now()
      try {
        if (!canEmit) throw new Error('A query cannot emit a signal. Use a mutation.')
        const declared = signals[String(name)]
        if (!declared) throw new Error('This app declares no signal named ' + String(name) + '. Add it to \`signals\` in app.ts.')
        if (kept.length >= 100) throw new Error('One call emits at most 100 signals.')
        let value = payload === undefined ? {} : payload
        if (declared.payload && typeof declared.payload.safeParse === 'function') {
          const parsed = declared.payload.safeParse(value)
          if (!parsed.success) throw new Error('The payload of the signal ' + String(name) + ' is not what the app declares: ' + issuesText(parsed.error))
          value = parsed.data
        }
        const text = JSON.stringify(value)
        if (Buffer.byteLength(text) > 65536) throw new Error('The payload of a signal is at most 64 KiB. Send a summary and an id.')
        kept.push({ name: String(name), payload: JSON.parse(text) })
        emitSpan(current, 'signal', String(name), startedAt, true, undefined, { 'messaging.operation.type': 'send', 'messaging.destination.name': String(name) })
      } catch (error) {
        emitSpan(current, 'signal', String(name), startedAt, false, reason(error))
        throw error
      }
    },
  })
}

function workflowsFace(canControl) {
  const control = (method, input) => {
    const current = scope.getStore()
    const startedAt = Date.now()
    return ask(method, input).then(
      (value) => { emitSpan(current, 'workflow', method.slice(10) + (input.workflow ? ' ' + input.workflow : ''), startedAt, true); return value },
      (error) => { emitSpan(current, 'workflow', method.slice(10), startedAt, false, reason(error)); throw error },
    )
  }
  return Object.freeze({
    start: (name, input, options) => (canControl
      ? control('workflows.start', { workflow: String(name), input: input === undefined ? {} : input, key: options && options.key ? String(options.key) : null })
      : Promise.reject(new Error('A query cannot start a workflow. Use a mutation.'))),
    get: (runId) => ask('workflows.get', { runId: String(runId) }),
    list: (options) => ask('workflows.list', { workflow: options && options.workflow ? String(options.workflow) : null, limit: options && options.limit ? Number(options.limit) : null }),
    terminate: (runId) => (canControl
      ? control('workflows.terminate', { runId: String(runId) })
      : Promise.reject(new Error('A query cannot end a run. Use a mutation.'))),
  })
}

// A model call (docs/plans/app-models.md): the host runs it; the runner sends the output's zod schema as JSON Schema and checks the result with the zod schema itself.
function modelRequest(setting, request) {
  const given = request || {}
  const plain = { setting: String(setting), prompt: given.prompt, input: given.input, tools: given.tools, effort: given.effort, timeoutSeconds: given.timeoutSeconds }
  if (given.output && typeof given.output.toJSONSchema === 'function') plain.output = given.output.toJSONSchema({ target: 'draft-7', io: 'output' })
  else if (given.output && typeof given.output === 'object') plain.output = given.output
  else if (given.output) throw new Error('The output of a model call is a zod schema, or a JSON Schema object.')
  return JSON.parse(JSON.stringify(plain))
}

function checkedModelResult(output, value) {
  if (!output || typeof output.safeParse !== 'function') return value
  const parsed = output.safeParse(value)
  if (!parsed.success) throw new Error('The result of the model call is not what the app asked for: ' + issuesText(parsed.error))
  return parsed.data
}

function modelsFace(canControl) {
  const traced = (name, work) => {
    const current = scope.getStore()
    const startedAt = Date.now()
    return Promise.resolve().then(work).then(
      (value) => { emitSpan(current, 'model', name, startedAt, true); return value },
      (error) => { emitSpan(current, 'model', name, startedAt, false, reason(error)); throw error },
    )
  }
  return Object.freeze({
    start: (setting, request) => (canControl
      ? traced('start ' + String(setting), () => ask('models.start', modelRequest(setting, request)))
      : Promise.reject(new Error('A query cannot start a model call. Use a mutation, or step.model in a workflow.'))),
    get: (id) => ask('models.get', { id: String(id) }),
    list: (options) => ask('models.list', { status: options && options.status ? String(options.status) : undefined, limit: options && options.limit ? Number(options.limit) : undefined }),
    cancel: (id) => (canControl
      ? ask('models.cancel', { id: String(id) })
      : Promise.reject(new Error('A query cannot cancel a model call. Use a mutation.'))),
  })
}

function load(message) {
  network = message.network
  protocol = message.protocol
  base = { secrets: Object.freeze({ ...message.secrets }), config: Object.freeze({ ...message.config }), filesDir: message.filesDir, blobsDir: path.join(message.appFolder, 'blobs') }
  for (const operation of message.operations) kinds.set(operation.name, operation.kind)
  const applied = openDatabase(path.join(message.appFolder, 'app.sqlite'), message.migrations)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', message.code)(require, module, module.exports, path.join(message.appFolder, 'backend.cjs'), message.appFolder)
  const definition = module.exports && module.exports.default ? module.exports.default : module.exports
  const part = (name) => (definition && definition[name] && typeof definition[name] === 'object' ? definition[name] : {})
  operations = part('operations')
  workflows = part('workflows')
  signals = part('signals')
  const missing = message.operations.map((operation) => operation.name).filter((name) => !operations[name] || typeof operations[name].handler !== 'function')
    .concat(message.workflows.filter((name) => !workflows[name] || typeof workflows[name].handler !== 'function'))
  if (missing.length > 0) throw new Error('The backend does not define ' + missing.join(', ') + ', which its descriptor declares.')
  send({ type: 'ready', applied })
}

function checkedInput(name, declared, raw) {
  if (!declared.input || typeof declared.input.safeParse !== 'function') return raw
  const parsed = declared.input.safeParse(raw)
  if (parsed.success) return parsed.data
  const text = issuesText(parsed.error)
  throw new Error('Invalid input for ' + name + (text ? ': ' + text : '.'))
}

function newScope(id) {
  return { id, startedAt: Date.now(), sql: { count: 0, ms: 0 }, signals: [] }
}

// The SQL of a call is one span: its statements and their total time.
function sqlSpan(current) {
  if (current.sql.count === 0) return
  send({ type: 'span', call: current.id, kind: 'sql', name: current.sql.count + (current.sql.count === 1 ? ' statement' : ' statements'), startMs: 0, durationMs: current.sql.ms, ok: true, attributes: { 'db.system.name': 'sqlite', 'db.operation.batch.size': current.sql.count } })
}

/** What an operation's handler gets, by the build's protocol (§6.3). */
function contextFor(kind, caller, current) {
  const db = kind === 'query' ? readDb : writeDb
  const context = {
    sql: db ? sqlFace(db, kind === 'query' ? 'BEGIN' : 'BEGIN IMMEDIATE') : noDatabase,
    secrets: base.secrets,
    tools: toolsFace(),
    caller: Object.freeze({ ...caller }),
  }
  if (protocol < 3) {
    context.files = base.filesDir
    return context
  }
  const canWrite = kind === 'mutation'
  context.config = base.config
  context.files = filesFace(canWrite)
  context.signals = signalsFace(current.signals, canWrite)
  context.workflows = workflowsFace(canWrite)
  context.models = modelsFace(canWrite)
  return context
}

async function call(message) {
  const operation = operations[message.name]
  const kind = kinds.get(message.name)
  if (!operation || !kind) {
    const names = [...kinds.keys()].join(', ') || 'none'
    send({ type: 'result', id: message.id, ok: false, changed: false, message: 'This app has no operation named ' + message.name + '. It has: ' + names + '.' })
    return
  }
  const current = newScope(message.id)
  await scope.run(current, async () => {
    const before = kind === 'mutation' ? totalChanges() : 0
    const changed = () => kind === 'mutation' && totalChanges() !== before
    let line
    try {
      const input = checkedInput(message.name, operation, message.input)
      let value = await operation.handler(contextFor(kind, message.caller, current), input)
      if (value === undefined) value = null
      if (protocol >= 3 && operation.output && typeof operation.output.safeParse === 'function') {
        const parsed = operation.output.safeParse(value)
        if (!parsed.success) throw new Error('The operation ' + message.name + ' returned a value that its output schema does not accept: ' + issuesText(parsed.error))
        value = parsed.data
      }
      line = JSON.stringify({ type: 'result', id: message.id, ok: true, value, changed: changed(), signals: current.signals, rssBytes: process.memoryUsage().rss })
    } catch (error) {
      line = JSON.stringify({ type: 'result', id: message.id, ok: false, message: reason(error), stack: stackOf(error), changed: changed(), rssBytes: process.memoryUsage().rss })
    }
    sqlSpan(current)
    process.stdout.write(line + '\\n')
  })
}

// ── Workflows: durable steps, retries, and sleep (§8.3) ──

const DURATION_UNITS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 }

function duration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const match = /^(\\d+(?:\\.\\d+)?)\\s*(second|minute|hour|day)s?$/.exec(String(value).trim())
  if (!match) throw new Error('A duration is a number of milliseconds or text such as "30 seconds", "5 minutes", "2 hours", or "1 day".')
  return Number(match[1]) * DURATION_UNITS[match[2]]
}

const MAX_STEP_TIMEOUT_MS = 30 * 60000
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60000
const MAX_RETRY_WAIT_MS = 60 * 60000
// A wait that is longer frees the runner: the host starts the run again when the time comes.
const WAIT_IN_PROCESS_MS = 60000
const MAX_STEPS = 1000

async function runWorkflow(message) {
  const declared = workflows[message.workflow]
  const current = newScope(message.id)
  await scope.run(current, async () => {
    const receipts = new Map(message.steps.map((step) => [step.name, step]))
    const used = new Set()
    let inFlight = 0
    let sleeping = 0
    let ended = false
    let suspend
    const suspension = new Promise((resolve) => { suspend = resolve })
    // The function waits only for a long sleep: nothing else is in progress, so the run can leave the process.
    const settle = () => setImmediate(() => {
      if (!ended && inFlight === 0 && sleeping > 0) suspend({ suspended: true })
    })
    const claim = (given) => {
      const name = String(given)
      if (!name || name.length > 200) throw new Error('A step name is 1 to 200 characters.')
      if (used.has(name)) throw new Error('The step name ' + name + ' is used twice in this run. Give each step of a run its own name.')
      if (used.size >= MAX_STEPS) throw new Error('A run has at most 1,000 steps.')
      used.add(name)
      return name
    }
    const tracked = async (work) => {
      inFlight += 1
      try {
        return await work()
      } finally {
        inFlight -= 1
        settle()
      }
    }

    async function doStep(given, options, fn) {
      if (typeof options === 'function') { fn = options; options = {} }
      const name = claim(given)
      const receipt = receipts.get(name)
      if (receipt && receipt.state === 'done') return receipt.result
      const retries = options && options.retries ? options.retries : null
      const limit = retries ? Math.max(0, Math.min(Number(retries.limit) || 0, 20)) : 0
      const delay = retries && retries.delay !== undefined ? duration(retries.delay) : 1000
      const backoff = retries && retries.backoff ? retries.backoff : 'constant'
      const timeout = Math.min(options && options.timeout !== undefined ? duration(options.timeout) : DEFAULT_STEP_TIMEOUT_MS, MAX_STEP_TIMEOUT_MS)
      let attempt = receipt ? Number(receipt.attempts) || 0 : 0
      return tracked(async () => {
        for (;;) {
          attempt += 1
          await ask('step.begin', { name, kind: 'do', attempt, timeoutMs: timeout })
          const controller = new AbortController()
          const emitted = []
          const startedAt = Date.now()
          let timer
          try {
            const context = Object.freeze({
              signal: controller.signal, attempt, idempotencyKey: message.runId + ':' + name,
              secrets: base.secrets, config: base.config, tools: toolsFace(), files: filesFace(true), signals: signalsFace(emitted, true),
            })
            let value = await Promise.race([
              Promise.resolve().then(() => fn(context)),
              new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort()
                  reject(new Error('The step ' + name + ' did not end in ' + Math.round(timeout / 1000) + ' seconds.'))
                }, timeout)
              }),
            ])
            clearTimeout(timer)
            if (value === undefined) value = null
            const text = JSON.stringify(value)
            if (Buffer.byteLength(text) > 1048576) {
              const tooLarge = new Error('The result of the step ' + name + ' is over 1 MiB. Keep large data in an app file or in the database, and return its id.')
              tooLarge.name = 'NonRetryableError'
              throw tooLarge
            }
            emitSpan(current, 'step', name, startedAt, true, attempt > 1 ? 'attempt ' + attempt : undefined, { step: name, attempt, 'retry.limit': limit, 'retry.delay_ms': delay, 'retry.backoff': backoff, 'step.timeout_ms': timeout })
            await ask('step.done', { name, result: JSON.parse(text), signals: emitted.map((signal, index) => ({ id: message.runId + ':' + name + ':' + index, name: signal.name, payload: signal.payload })) })
            return JSON.parse(text)
          } catch (error) {
            clearTimeout(timer)
            controller.abort()
            emitSpan(current, 'step', name, startedAt, false, reason(error), { step: name, attempt, 'retry.limit': limit, 'retry.delay_ms': delay, 'retry.backoff': backoff, 'step.timeout_ms': timeout })
            if (attempt > limit || (error && (error.name === 'NonRetryableError' || error.fromHost))) {
              await ask('step.fail', { name, error: reason(error) }).catch(() => {})
              throw error
            }
            const wait = Math.min(backoff === 'exponential' ? delay * Math.pow(2, attempt - 1) : backoff === 'linear' ? delay * attempt : delay, MAX_RETRY_WAIT_MS)
            await ask('step.retry', { name, attempt, error: reason(error), waitMs: wait })
            await new Promise((resolve) => setTimeout(resolve, wait))
          }
        }
      })
    }

    async function sleepStep(given, wakeTime, length) {
      const name = claim(given)
      const receipt = receipts.get(name)
      if (receipt && receipt.state === 'done') return
      const wakeAt = receipt && receipt.wakeAt ? Number(receipt.wakeAt) : wakeTime !== null ? wakeTime : Date.now() + length
      if (!Number.isFinite(wakeAt)) throw new Error('The step ' + name + ' has no time to wake at.')
      if (!receipt) await ask('step.sleep', { name, wakeAt })
      const wait = wakeAt - Date.now()
      if (wait > WAIT_IN_PROCESS_MS) {
        sleeping += 1
        settle()
        // The run starts again when the time comes, and this step then answers from its receipt.
        return new Promise(() => {})
      }
      return tracked(async () => {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        await ask('step.done', { name, result: null, signals: [] })
      })
    }

    function operationStep(kind, given, operation, input) {
      const name = claim(given)
      const receipt = receipts.get(name)
      if (receipt && receipt.state === 'done') return Promise.resolve(receipt.result)
      return tracked(() => ask('step.op', { name, kind, operation: String(operation), input: input === undefined ? {} : input }))
    }

    function modelStep(given, setting, request) {
      const name = claim(given)
      const output = request && request.output
      const receipt = receipts.get(name)
      if (receipt && receipt.state === 'done') return Promise.resolve().then(() => checkedModelResult(output, receipt.result))
      return tracked(async () => checkedModelResult(output, await ask('step.model', { name, request: modelRequest(setting, request) })))
    }

    const step = Object.freeze({
      do: doStep,
      model: modelStep,
      sleep: (name, length) => sleepStep(name, null, duration(length)),
      sleepUntil: (name, time) => sleepStep(name, time instanceof Date ? time.getTime() : Number(time), 0),
      runQuery: (name, operation, input) => operationStep('query', name, operation, input),
      runMutation: (name, operation, input) => operationStep('mutation', name, operation, input),
    })

    let line
    try {
      if (!declared || typeof declared.handler !== 'function') throw new Error('This app has no workflow named ' + message.workflow + '.')
      const input = checkedInput(message.workflow, declared, message.input)
      const outcome = await Promise.race([
        Promise.resolve().then(() => declared.handler(Object.freeze({ runId: message.runId, step }), input)).then((value) => ({ value: value === undefined ? null : value })),
        suspension,
      ])
      ended = true
      if (outcome.suspended) line = JSON.stringify({ type: 'result', id: message.id, ok: true, suspended: true, value: null, changed: false, rssBytes: process.memoryUsage().rss })
      else {
        const text = JSON.stringify(outcome.value)
        if (Buffer.byteLength(text) > 1048576) throw new Error('The result of the workflow ' + message.workflow + ' is over 1 MiB.')
        line = JSON.stringify({ type: 'result', id: message.id, ok: true, value: JSON.parse(text), changed: false, rssBytes: process.memoryUsage().rss })
      }
    } catch (error) {
      ended = true
      line = JSON.stringify({ type: 'result', id: message.id, ok: false, message: reason(error), stack: stackOf(error), changed: false, rssBytes: process.memoryUsage().rss })
    }
    process.stdout.write(line + '\\n')
  })
}

const lines = require('node:readline').createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === 'load') {
    try {
      load(message)
    } catch (error) {
      send({ type: 'failed', message: reason(error) })
      process.exit(1)
    }
  } else if (message.type === 'call') {
    void call(message)
  } else if (message.type === 'run') {
    void runWorkflow(message)
  } else if (message.type === 'reply') {
    const wait = waits.get(message.id)
    if (!wait) return
    waits.delete(message.id)
    if (message.ok) wait.resolve(message.value)
    else {
      const error = new Error(message.message || 'The host refused the request.')
      error.fromHost = true
      wait.reject(error)
    }
  }
})
// The host closed the pipe: it stopped, or it stopped this runner.
lines.on('close', () => process.exit(0))
`
