import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each test file runs in its own process, so the data folder can be set before import.
const dataFolder = mkdtempSync(join(tmpdir(), 'solus-server-lock-'))
process.env.SOLUS_DATA_DIR = dataFolder
const { otherServerOnDataFolder, dataFolderInUseMessage } = await import('@solus/server/host/server-lock')

let other: ChildProcess
let otherPort = 0

beforeAll(async () => {
  // Another server: a separate process that listens on a port, as a running Solus does.
  other = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"], { stdio: ['ignore', 'pipe', 'ignore'] })
  otherPort = await new Promise<number>((resolve) => other.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim()))))
})

afterAll(() => {
  other.kill()
  rmSync(dataFolder, { recursive: true, force: true })
})

function writeLock(pid: number, port: number, host = '0.0.0.0'): void {
  writeFileSync(join(dataFolder, 'server.lock'), JSON.stringify({ pid, port, host, startedAt: Date.now() }))
}

describe('a data folder another server owns', () => {
  test('a running server that answers on its port owns the folder, and boot names it', async () => {
    // WHY: the desktop app and the standalone server both default to ~/.solus;
    // two servers on one folder share one SQLite database.
    writeLock(other.pid!, otherPort)
    const owner = await otherServerOnDataFolder()
    expect(owner).toMatchObject({ pid: other.pid, port: otherPort })
    expect(dataFolderInUseMessage(owner!)).toContain(String(other.pid))
    expect(dataFolderInUseMessage(owner!)).toContain('SOLUS_DATA_DIR')
  })

  test('a lock left by a server that died is not an owner', async () => {
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => dead.once('exit', resolve))
    writeLock(dead.pid!, otherPort)
    expect(await otherServerOnDataFolder()).toBeNull()
  })

  test('a reused process id with nothing on the lock port is not an owner', async () => {
    // WHY: Windows reuses process ids, so a live id alone could be any program.
    writeLock(other.pid!, 1)
    expect(await otherServerOnDataFolder()).toBeNull()
  })

  test('this process own lock is not another server', async () => {
    writeLock(process.pid, otherPort)
    expect(await otherServerOnDataFolder()).toBeNull()
  })

  test('no lock, no owner', async () => {
    rmSync(join(dataFolder, 'server.lock'), { force: true })
    expect(await otherServerOnDataFolder()).toBeNull()
  })
})
