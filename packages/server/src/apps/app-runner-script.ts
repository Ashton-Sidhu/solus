/**
 * The program an app's runner starts with (docs/plans/apps.md §6), passed to
 * Node as `-e`. It runs under Node's permission model, which confines the file
 * system module and refuses child processes, workers, and native add-ons. Two
 * things the permission model does not cover are checked here, before any
 * line of the app runs: the host of every socket, and the path `node:sqlite`
 * opens.
 *
 * It then opens the app's own database, applies the migrations the version
 * brings, loads the backend module, and runs its operations. A query gets the
 * read-only connection, whatever its code does: the kind comes from the
 * descriptor the host holds, not from the module.
 *
 * The protocol is one JSON object on each line. Requests arrive on stdin:
 * `load` once, then `call`, and `tool-result` for each `tool` the runner
 * asked. Answers leave on stdout: `ready` or `failed`, one `result` for each
 * call, and `tool` when an operation calls an integration. What the app
 * prints goes to stderr.
 *
 * Plain JavaScript in a string, like the member file script: it must start on
 * the host's own Node with no file of its own to read.
 */
export const APP_RUNNER_SCRIPT = `'use strict'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
console.log = console.info = console.debug = (...args) => console.error(...args)

if (!process.permission || typeof process.permission.has !== 'function') {
  send({ type: 'failed', message: 'This host cannot confine an app: its Node runtime has no permission model.' })
  process.exit(1)
}

const net = require('node:net')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
let network = []

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

// ── The app's own database ──

let writeDb = null
let readDb = null

function sqlFace(db, begin) {
  return Object.freeze({
    exec(text, ...values) {
      const rows = db.prepare(String(text)).all(...values)
      return { all: () => rows, one: () => (rows.length > 0 ? rows[0] : null) }
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

function openDatabase(file, migrations) {
  if (!OwnDatabase) {
    if (migrations.length > 0) throw new Error('This host\\'s Node has no node:sqlite, so it cannot run an app with migrations.')
    return []
  }
  writeDb = new OwnDatabase(file)
  writeDb.exec('PRAGMA journal_mode = WAL')
  writeDb.exec('PRAGMA foreign_keys = ON')
  writeDb.exec('CREATE TABLE IF NOT EXISTS solus_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)')
  const known = new Set(writeDb.prepare('SELECT name FROM solus_migrations').all().map((row) => row.name))
  const applied = []
  for (const migration of migrations) {
    if (known.has(migration.name)) continue
    writeDb.exec('BEGIN IMMEDIATE')
    try {
      writeDb.exec(migration.sql)
      writeDb.prepare('INSERT INTO solus_migrations (name, applied_at) VALUES (?, ?)').run(migration.name, Date.now())
      writeDb.exec('COMMIT')
    } catch (error) {
      try { writeDb.exec('ROLLBACK') } catch {}
      throw new Error('The migration ' + migration.name + ' failed: ' + reason(error))
    }
    applied.push(migration.name)
  }
  readDb = new OwnDatabase(file, { readOnly: true })
  return applied
}

function totalChanges() {
  return writeDb ? Number(writeDb.prepare('SELECT total_changes() AS n').get().n) : 0
}

// ── Integration calls go to the host, which holds the caller's connection ──

const toolWaits = new Map()
let nextToolId = 1

function toolsFace(callId) {
  return new Proxy({}, {
    get: (_target, slug) => new Proxy({}, {
      get: (_inner, tool) => (input) => new Promise((resolve, reject) => {
        const id = nextToolId++
        toolWaits.set(id, { resolve, reject })
        send({ type: 'tool', id, call: callId, slug: String(slug), tool: String(tool), input: input === undefined ? {} : input })
      }),
    }),
  })
}

// ── The backend ──

let operations = {}
const kinds = new Map()
let base = { secrets: Object.freeze({}), files: '' }

function load(message) {
  network = message.network
  base = { secrets: Object.freeze({ ...message.secrets }), files: message.filesDir }
  for (const operation of message.operations) kinds.set(operation.name, operation.kind)
  const applied = openDatabase(path.join(message.appFolder, 'app.sqlite'), message.migrations)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', message.code)(require, module, module.exports, path.join(message.appFolder, 'backend.cjs'), message.appFolder)
  const definition = module.exports && module.exports.default ? module.exports.default : module.exports
  operations = definition && definition.operations && typeof definition.operations === 'object' ? definition.operations : {}
  const missing = message.operations.map((operation) => operation.name).filter((name) => !operations[name] || typeof operations[name].handler !== 'function')
  if (missing.length > 0) throw new Error('The backend does not define ' + missing.join(', ') + ', which its descriptor declares. Run npm run bundle again.')
  send({ type: 'ready', applied })
}

function checkedInput(name, operation, raw) {
  if (!operation.input || typeof operation.input.safeParse !== 'function') return raw
  const parsed = operation.input.safeParse(raw)
  if (parsed.success) return parsed.data
  const issues = parsed.error && Array.isArray(parsed.error.issues) ? parsed.error.issues : []
  const text = issues.map((issue) => ((issue.path || []).join('.') || 'input') + ': ' + issue.message).join('; ')
  throw new Error('Invalid input for ' + name + (text ? ': ' + text : '.'))
}

async function call(message) {
  const operation = operations[message.name]
  const kind = kinds.get(message.name)
  if (!operation || !kind) {
    const names = [...kinds.keys()].join(', ') || 'none'
    send({ type: 'result', id: message.id, ok: false, changed: false, message: 'This app has no operation named ' + message.name + '. It has: ' + names + '.' })
    return
  }
  const before = kind === 'mutation' ? totalChanges() : 0
  try {
    const input = checkedInput(message.name, operation, message.input)
    const db = kind === 'query' ? readDb : writeDb
    const context = {
      sql: db ? sqlFace(db, kind === 'query' ? 'BEGIN' : 'BEGIN IMMEDIATE') : noDatabase,
      secrets: base.secrets,
      files: base.files,
      tools: toolsFace(message.id),
      caller: Object.freeze({ ...message.caller }),
    }
    const value = await operation.handler(context, input)
    send({ type: 'result', id: message.id, ok: true, value: value === undefined ? null : value, changed: kind === 'mutation' && totalChanges() !== before })
  } catch (error) {
    send({ type: 'result', id: message.id, ok: false, message: reason(error), changed: kind === 'mutation' && totalChanges() !== before })
  }
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
  } else if (message.type === 'tool-result') {
    const wait = toolWaits.get(message.id)
    if (!wait) return
    toolWaits.delete(message.id)
    if (message.ok) wait.resolve(message.value)
    else wait.reject(new Error(message.message || 'The integration call failed.'))
  }
})
// The host closed the pipe: it stopped, or it stopped this runner.
lines.on('close', () => process.exit(0))
`
