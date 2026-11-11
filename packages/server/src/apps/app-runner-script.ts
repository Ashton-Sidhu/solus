/**
 * The program an app's runner starts with (docs/plans/apps.md §6), passed to
 * Node as `-e`. It runs under Node's permission model, which confines the file
 * system module and refuses child processes, workers, and native add-ons. Two
 * things the permission model does not cover are checked here, before any
 * line of the app runs: the host of every socket, and the path `node:sqlite`
 * opens.
 *
 * The protocol is one JSON object on each line. Requests arrive on stdin:
 * `load` once, then `call`. Answers leave on stdout: `ready` or `failed`, then
 * one `result` for each call. What the app prints goes to stderr.
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
  const error = new Error('This app is not allowed to ' + what + '. Its host access does not include it.')
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
try {
  const sqlite = require('node:sqlite')
  const Database = sqlite.DatabaseSync
  sqlite.DatabaseSync = class DatabaseSync extends Database {
    constructor(location, ...rest) {
      const options = rest[0]
      let file = location instanceof URL ? fileURLToPath(location) : String(location)
      if (file !== '' && file !== ':memory:') {
        if (file.startsWith('file:')) file = fileURLToPath(file.split('?')[0])
        const resolved = path.resolve(file)
        if (!process.permission.has('fs.read', resolved)) throw denied('read ' + resolved)
        if (!(options && options.readOnly) && !process.permission.has('fs.write', resolved)) {
          throw denied('write ' + resolved + ' (open it with { readOnly: true }, or ask for write access)')
        }
      }
      super(location, ...rest)
    }
  }
} catch {
  // This Node has no node:sqlite. An app that needs it fails on its own require.
}
require('node:module').syncBuiltinESMExports()

const functions = new Map()
let context = { dataDir: '' }

function load(message) {
  network = message.network
  context = { dataDir: message.dataDir }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__filename', '__dirname', message.code)(require, module, module.exports, path.join(message.dataDir, 'server.js'), message.dataDir)
  for (const [name, value] of Object.entries(module.exports)) {
    if (typeof value === 'function' && name !== 'default') functions.set(name, value)
  }
  send({ type: 'ready', functions: [...functions.keys()] })
}

function reason(error) {
  // Node's own refusal names a flag the person cannot set; say what the app's host access lacks.
  if (error && error.code === 'ERR_ACCESS_DENIED' && error.permission) {
    return 'This app is not allowed to use ' + error.permission + (error.resource ? ' on ' + error.resource : '') + '. Its host access does not include it.'
  }
  const message = error && error.message ? String(error.message) : String(error)
  const cause = error && error.cause && error.cause.message ? ': ' + error.cause.message : ''
  return message + cause
}

async function call(message) {
  const run = functions.get(message.name)
  if (!run) {
    const names = [...functions.keys()].join(', ') || 'none'
    send({ type: 'result', id: message.id, ok: false, message: 'This app has no host function named ' + message.name + '. It has: ' + names + '.' })
    return
  }
  try {
    const value = await run(message.input, context)
    send({ type: 'result', id: message.id, ok: true, value: value === undefined ? null : value })
  } catch (error) {
    send({ type: 'result', id: message.id, ok: false, message: reason(error) })
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
      send({ type: 'failed', message: 'The app\\'s host code did not load: ' + reason(error) })
      process.exit(1)
    }
  } else if (message.type === 'call') {
    void call(message)
  }
})
// The server closed the pipe: it stopped, or it stopped this runner.
lines.on('close', () => process.exit(0))
`
