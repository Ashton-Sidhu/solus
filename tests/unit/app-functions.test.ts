import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppHostAccess } from '@solus/contracts/apps'
import { AppFunctions, runnerArguments, type AppFunctionsRun } from '@solus/server/apps/app-functions'

/**
 * An app's host functions run in a real Node under its permission model, so
 * these tests start one: Bun has no permission model and the runner refuses to
 * load an app without it. A machine with no Node 22 or later skips them.
 */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const hasNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22
const describeWithNode = hasNode ? describe : describe.skip

// The real path: the permission model compares the path a call names, and macOS reaches its temp folder through a link.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-app-functions-')))
const dataFolder = join(root, 'app', 'data')
const granted = join(root, 'granted')
const outside = join(root, 'outside')
for (const folder of [dataFolder, granted, outside]) mkdirSync(folder, { recursive: true })
writeFileSync(join(granted, 'in.txt'), 'inside')
writeFileSync(join(outside, 'out.txt'), 'outside')

const SERVER = `
const fs = require('node:fs')
const path = require('node:path')
exports.echo = async (input, context) => ({ input, dataDir: context.dataDir })
exports.read = async ({ file }) => fs.readFileSync(file, 'utf8')
exports.keep = async ({ text }, context) => { fs.writeFileSync(path.join(context.dataDir, 'kept.txt'), text); return 'kept' }
exports.write = async ({ file }) => { fs.writeFileSync(file, 'x'); return 'written' }
exports.shell = async () => require('node:child_process').execSync('echo escaped').toString()
exports.get = async ({ url }) => (await fetch(url)).text()
exports.open = async ({ file, readOnly }) => { const { DatabaseSync } = require('node:sqlite'); (readOnly === undefined ? new DatabaseSync(file) : new DatabaseSync(file, { readOnly })).close(); return 'opened' }
exports.fail = async () => { throw new Error('the query is wrong') }
exports.hang = () => new Promise(() => {})
exports.notAFunction = 1
`

const access = (extra: Partial<AppHostAccess> = {}): AppHostAccess => ({ functions: true, network: [], files: { read: [], write: [] }, ...extra })

let functions: AppFunctions | null = null
function start(options: { callTimeoutMs?: number } = {}): AppFunctions {
  functions = new AppFunctions({ node: 'node', ...options })
  return functions
}
const run = (extra: Partial<AppFunctionsRun> = {}): AppFunctionsRun => ({ workId: 'app-1', contentVersion: 1, server: SERVER, access: access(), dataFolder, ...extra })

afterEach(() => {
  functions?.dispose()
  functions = null
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('runner arguments', () => {
  test('the permission model gets the app\'s folder and its paths, a write path is also read, and the network flag goes only to a Node that has it', () => {
    const args = runnerArguments(access({ network: ['db.internal:5432'], files: { read: ['/srv/in'], write: ['/srv/out'] } }), '/data/app', true)
    expect(args.slice(0, 7)).toEqual(['--permission', '--allow-fs-read=/data/app', '--allow-fs-read=/srv/out', '--allow-fs-read=/srv/in', '--allow-fs-write=/data/app', '--allow-fs-write=/srv/out', '--allow-net'])
    // Node 24 does not know the flag and would not start with it.
    expect(runnerArguments(access({ network: ['*'] }), '/data/app', false)).not.toContain('--allow-net')
    // No network host: a Node with the network permission refuses every socket by itself.
    expect(runnerArguments(access(), '/data/app', true)).not.toContain('--allow-net')
  })
})

describeWithNode('app host functions', () => {
  test('a host function gets the frame\'s input and the app\'s data folder, and its value comes back', async () => {
    const functions = start()
    expect(await functions.call(run(), 'echo', { table: 'users' })).toEqual({ input: { table: 'users' }, dataDir: dataFolder })
    expect(await functions.call(run(), 'keep', { text: 'mine' })).toBe('kept')
    expect(readFileSync(join(dataFolder, 'kept.txt'), 'utf8')).toBe('mine')
  })

  test('the file system is the app\'s own folder and the paths its host access names, and nothing else', async () => {
    // WHY: the owner allowed a list of paths. A host function that reads or
    // writes outside it would make that decision mean nothing.
    const functions = start()
    const withPaths = run({ access: access({ files: { read: [granted], write: [] } }) })
    expect(await functions.call(withPaths, 'read', { file: join(granted, 'in.txt') })).toBe('inside')
    await expect(functions.call(withPaths, 'read', { file: join(outside, 'out.txt') })).rejects.toThrow(`not allowed to use FileSystemRead on ${join(outside, 'out.txt')}`)
    // A path it may read is not a path it may write.
    await expect(functions.call(withPaths, 'write', { file: join(granted, 'new.txt') })).rejects.toThrow()
    expect(existsSync(join(granted, 'new.txt'))).toBe(false)
  })

  test('a host function cannot start a process', async () => {
    await expect(start().call(run(), 'shell', {})).rejects.toThrow()
  })

  test('node:sqlite opens only a path the host access names', async () => {
    // WHY: node:sqlite does not ask the permission model, so the runner checks the path itself.
    const functions = start()
    const withPaths = run({ access: access({ files: { read: [granted], write: [] } }) })
    await expect(functions.call(withPaths, 'open', { file: join(outside, 'other.db'), readOnly: false })).rejects.toThrow('not allowed to read')
    expect(existsSync(join(outside, 'other.db'))).toBe(false)
    await expect(functions.call(withPaths, 'open', { file: join(granted, 'new.db'), readOnly: false })).rejects.toThrow('readOnly')
    expect(await functions.call(withPaths, 'open', { file: join(dataFolder, 'own.db') })).toBe('opened')
  })

  describe('network', () => {
    let server: Server
    let port = 0
    const listen = () => new Promise<void>((resolve) => {
      server = createServer((_request, response) => response.end('reached')).listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

    test('a host function reaches a host the access names and no other', async () => {
      // WHY: the desktop app's Node has no network permission, so the check in
      // the runner is the only thing between an app and every host.
      await listen()
      const functions = start()
      const url = `http://127.0.0.1:${port}/`
      await expect(functions.call(run(), 'get', { url })).rejects.toThrow()
      await expect(functions.call(run({ access: access({ network: ['example.com'] }) }), 'get', { url })).rejects.toThrow('not allowed to reach 127.0.0.1')
      await expect(functions.call(run({ access: access({ network: ['127.0.0.1:1'] }) }), 'get', { url })).rejects.toThrow('not allowed to reach')
      expect(await functions.call(run({ access: access({ network: [`127.0.0.1:${port}`] }) }), 'get', { url })).toBe('reached')
      expect(await functions.call(run({ access: access({ network: ['*'] }) }), 'get', { url })).toBe('reached')
    })
  })

  test('a function that throws, a name the app does not export, and code that does not load each say what happened', async () => {
    const functions = start()
    await expect(functions.call(run(), 'fail', {})).rejects.toThrow('the query is wrong')
    await expect(functions.call(run(), 'missing', {})).rejects.toThrow('no host function named missing')
    await expect(functions.call(run(), 'notAFunction', {})).rejects.toThrow('no host function named notAFunction')
    await expect(functions.call(run({ workId: 'app-2', server: 'this is not javascript' }), 'echo', {})).rejects.toThrow('did not load')
  })

  test('a function that never answers fails its call and does not hold the next one', async () => {
    const functions = start({ callTimeoutMs: 300 })
    await expect(functions.call(run(), 'hang', {})).rejects.toThrow('did not answer')
    expect(await functions.call(run(), 'echo', {})).toEqual({ input: {}, dataDir: dataFolder })
  })

  test('a new revision runs the new code, not the process of the old one', async () => {
    const functions = start()
    expect(await functions.call(run({ server: 'exports.version = async () => 1' }), 'version', {})).toBe(1)
    expect(await functions.call(run({ contentVersion: 2, server: 'exports.version = async () => 2' }), 'version', {})).toBe(2)
  })
})
