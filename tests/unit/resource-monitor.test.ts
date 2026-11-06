import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ResourceMonitor, resourceMonitorCandidates, type MonitorChild, type MonitorSnapshot } from '../../packages/server/src/host/resource-monitor'
import { resourceMonitorBinaryName, resourceMonitorRustTarget } from '../../scripts/build-resource-monitor'

/** A stand-in for the child: what the server writes, and a way to answer. */
function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: string[] = []
  stdin.on('data', (chunk: Buffer) => written.push(...chunk.toString().trim().split('\n')))
  let killed = false
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => { killed = true; return true } })
  return {
    child: child as unknown as MonitorChild,
    emit: child,
    stdout,
    commands: () => written.map((line) => JSON.parse(line) as { type: string; version: number; sampleIntervalMs?: number; enabled?: boolean }),
    wasKilled: () => killed,
  }
}

function start(fake: ReturnType<typeof fakeChild>) {
  const snapshots: MonitorSnapshot[] = []
  let failed = 0
  const monitor = new ResourceMonitor({
    path: '/bin/monitor',
    rootPid: 42,
    sampleIntervalMs: 2_000,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onFailed: () => { failed += 1 },
    spawnChild: () => fake.child,
  })
  return { monitor, snapshots, failures: () => failed }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const process = { pid: 1, ppid: 0, name: 'node', command: 'node x', cpuPercent: 1, residentBytes: 2 }

describe('ResourceMonitor', () => {
  test('configures the child for this server and streams', async () => {
    const fake = fakeChild()
    start(fake)
    await flush()
    expect(fake.commands().map((command) => command.type)).toEqual(['configure', 'setStreaming'])
    expect(fake.commands()[0]).toMatchObject({ version: 3, rootPid: 42, sampleIntervalMs: 2_000 })
  })

  test('a stopped sampler neither samples nor streams, so an idle server walks no table', async () => {
    const fake = fakeChild()
    const { monitor } = start(fake)
    monitor.setSampling(0)
    await flush()
    expect(fake.commands().slice(-2)).toMatchObject([{ type: 'setStreaming', enabled: false }, { type: 'setSampleInterval', sampleIntervalMs: 0 }])
  })

  test('reads lines that arrive in pieces', async () => {
    const fake = fakeChild()
    const { snapshots } = start(fake)
    const line = JSON.stringify({ type: 'snapshot', sampledAtUnixMs: 5, processes: [process], extra: true })
    fake.stdout.write(line.slice(0, 10))
    await flush()
    expect(snapshots).toHaveLength(0)
    fake.stdout.write(`${line.slice(10)}\n`)
    await flush()
    expect(snapshots[0]?.processes[0]?.pid).toBe(1)
  })

  test('a child that speaks another protocol is not used', async () => {
    const fake = fakeChild()
    const { failures } = start(fake)
    fake.stdout.write('{"type":"hello","version":99}\n')
    await flush()
    expect(failures()).toBe(1)
    expect(fake.wasKilled()).toBe(true)
  })

  test('output it cannot read fails the monitor and nothing else', async () => {
    const fake = fakeChild()
    const { failures } = start(fake)
    fake.stdout.write('not json\n')
    await flush()
    expect(failures()).toBe(1)
  })

  test('a recoverable report keeps the monitor, a fatal one ends it', async () => {
    const fake = fakeChild()
    const { failures } = start(fake)
    fake.stdout.write('{"type":"error","code":"x","message":"m","recoverable":true}\n')
    await flush()
    expect(failures()).toBe(0)
    fake.stdout.write('{"type":"error","code":"x","message":"m","recoverable":false}\n')
    await flush()
    expect(failures()).toBe(1)
  })

  test('an unbounded line does not grow the server without end', async () => {
    const fake = fakeChild()
    const { failures } = start(fake)
    fake.stdout.write('x'.repeat(9 * 1024 * 1024))
    await flush()
    expect(failures()).toBe(1)
  })

  test('a missing binary and a crash each report one failure, and stop does not', async () => {
    const missing = fakeChild()
    const first = start(missing)
    missing.emit.emit('error', new Error('ENOENT'))
    missing.emit.emit('close', null)
    expect(first.failures()).toBe(1)

    const stopped = fakeChild()
    const second = start(stopped)
    second.monitor.stop()
    stopped.emit.emit('close', 0)
    expect(second.failures()).toBe(0)
  })
})

describe('resourceMonitorCandidates', () => {
  const name = globalThis.process.platform === 'win32' ? 'solus-resource-monitor.exe' : 'solus-resource-monitor'

  test('a standalone package finds it under its install folder', () => {
    expect(resourceMonitorCandidates({ SOLUS_INSTALL_DIR: '/opt/solus' }, null)).toEqual([join('/opt/solus', 'libexec', 'native', 'resource-monitor', name)])
  })

  test('a packaged desktop finds it beside app.asar, where extraResources puts it', () => {
    expect(resourceMonitorCandidates({}, { appPath: '/App/Resources/app.asar', isPackaged: true })).toEqual([join('/App/Resources', 'resource-monitor', name)])
  })

  test('a development desktop finds the local build', () => {
    expect(resourceMonitorCandidates({}, { appPath: '/repo', isPackaged: false })).toEqual([join('/repo', 'build', 'resource-monitor', 'bin', name)])
  })

  test('an override comes first', () => {
    expect(resourceMonitorCandidates({ SOLUS_RESOURCE_MONITOR_PATH: '/x', SOLUS_INSTALL_DIR: '/opt/solus' }, null)[0]).toBe('/x')
  })
})

// The contract between this client and the copied Rust source: it runs where a
// build exists, so a change to either side fails here.
const host = { platform: globalThis.process.platform === 'win32' ? 'win32' : globalThis.process.platform === 'linux' ? 'linux' : 'darwin', arch: globalThis.process.arch === 'x64' ? 'x64' : 'arm64' } as const
const built = join(globalThis.process.cwd(), 'build/resource-monitor/target', resourceMonitorRustTarget(host), 'release', resourceMonitorBinaryName(host.platform))
describe.skipIf(!existsSync(built))('the real monitor', () => {
  test('samples this process tree and exits when the server goes', async () => {
    const received: MonitorSnapshot[] = []
    let failed = false
    const monitor = new ResourceMonitor({
      path: built,
      rootPid: globalThis.process.pid,
      sampleIntervalMs: 250,
      onSnapshot: (snapshot) => received.push(snapshot),
      onFailed: () => { failed = true },
    })
    while (received.length === 0) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(received[0]?.processes.some((row) => row.pid === globalThis.process.pid)).toBe(true)
    monitor.stop()
    expect(failed).toBe(false)
  }, 10_000)
})
