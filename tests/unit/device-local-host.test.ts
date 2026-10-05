import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDeviceHost } from '@solus/server/devices/local-device-host'
import { DeviceToolchain } from '@solus/server/devices/device-toolchain'
import { androidUnavailableReason, findAndroidSdk, iosUnavailableReason } from '@solus/server/devices/device-platform-probe'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'
import type { HelperProcess } from '@solus/server/devices/device-helpers'

/**
 * The local device host: probes are read-only, the hub runs as a supervised
 * child on loopback, and stopping helpers signals only the PID Solus started.
 */

const nodeRun: DeviceCommandRunner = async (command, args) => {
  if (args[0] === '--version') return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
  if (command === 'xcode-select') return { code: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '' }
  if (command === 'xcrun') return { code: 0, stdout: JSON.stringify({ runtimes: [{ platform: 'iOS', isAvailable: true }] }), stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

function installedToolchain(dir: string): DeviceToolchain {
  const toolchain = new DeviceToolchain(join(dir, 'tools'), nodeRun)
  for (const tool of ['hub', 'agent'] as const) {
    const paths = toolchain.paths(tool)
    mkdirSync(join(paths.entryPath, '..'), { recursive: true })
    writeFileSync(paths.entryPath, '// entry')
    writeFileSync(paths.sentinelPath, `${tool === 'hub' ? '0.12.0' : '0.21.12'}\n`)
  }
  return toolchain
}

function fakeProcess(pid: number) {
  let exit: (code: number | null) => void = () => {}
  const process: HelperProcess & { killed: number } = {
    pid,
    killed: 0,
    exited: new Promise((resolve) => { exit = resolve }),
    kill: () => { process.killed++; exit(0) },
  }
  return process
}

describe('platform probes', () => {
  test('Command Line Tools are not reported as missing Xcode', async () => {
    // WHY: the fix differs. With Xcode installed but not selected, the user
    // needs xcode-select, not an App Store download.
    const run: DeviceCommandRunner = async () => ({ code: 0, stdout: '/Library/Developer/CommandLineTools\n', stderr: '' })
    const reason = await iosUnavailableReason({ env: {}, hostPlatform: 'darwin', run, exists: (path) => path === '/Applications/Xcode.app' })
    expect(reason).toContain('xcode-select -s')
    const withoutXcode = await iosUnavailableReason({ env: {}, hostPlatform: 'darwin', run, exists: () => false })
    expect(withoutXcode).toContain('full Xcode')
  })

  test('a missing simulator runtime is reported separately', async () => {
    const run: DeviceCommandRunner = async (command) => (command === 'xcode-select'
      ? { code: 0, stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' }
      : { code: 0, stdout: '{"runtimes":[]}', stderr: '' })
    expect(await iosUnavailableReason({ env: {}, hostPlatform: 'darwin', run })).toContain('No iOS simulator runtime')
  })

  test('Linux hosts cannot run iOS simulators', async () => {
    expect(await iosUnavailableReason({ env: {}, hostPlatform: 'linux', run: nodeRun })).toContain('macOS')
  })

  test('the Android SDK is found from ANDROID_HOME and each missing tool is named', () => {
    const present = new Set(['/sdk/platform-tools/adb', '/sdk/emulator/emulator'])
    const sdk = findAndroidSdk({ env: { ANDROID_HOME: '/sdk' }, hostPlatform: 'darwin', exists: (path) => present.has(path) })
    expect(sdk.root).toBe('/sdk')
    expect(androidUnavailableReason(sdk)).toContain('Command-line Tools (latest)')
    expect(androidUnavailableReason({ ...sdk, root: null })).toContain('ANDROID_HOME')
  })
})

describe('local device host', () => {
  test('summary installs and starts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    let spawned = 0
    const host = new LocalDeviceHost({
      stateDir: join(dir, 'state'),
      toolchain: new DeviceToolchain(join(dir, 'tools'), nodeRun),
      run: nodeRun,
      spawn: () => { spawned++; return fakeProcess(1) },
      env: { PATH: '' },
      hostPlatform: 'darwin',
    })
    const summary = await host.summary()
    expect(spawned).toBe(0)
    expect(summary.hubInstalled).toBe(false)
    expect(host.current()).toBeNull()
  })

  test('the hub starts once on loopback, records its PID, and stop kills only that PID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const child = fakeProcess(4242)
    const spawns: string[][] = []
    const host = new LocalDeviceHost({
      stateDir: join(dir, 'state'),
      toolchain: installedToolchain(dir),
      run: nodeRun,
      spawn: (_command, args) => { spawns.push([...args]); return child },
      env: { PATH: '/opt/homebrew/bin' },
      hostPlatform: 'darwin',
      resolveNode: async () => ({ nodePath: '/fake/node' }),
      fetch: (async () => new Response('ok')) as unknown as typeof fetch,
      reservePort: async () => 45123,
    })
    const phases: string[] = []
    const [a, b] = await Promise.all([host.ensureReady((phase) => phases.push(phase)), host.ensureReady(() => {})])
    expect(a.hubOrigin).toBe('http://127.0.0.1:45123')
    expect(b.hubOrigin).toBe(a.hubOrigin)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toContain('--host')
    expect(spawns[0]![spawns[0]!.indexOf('--host') + 1]).toBe('127.0.0.1')
    expect(phases).toEqual(['starting'])
    expect(JSON.parse(readFileSync(join(dir, 'state', 'hub.json'), 'utf8')).pid).toBe(4242)
    await host.stop()
    expect(child.killed).toBe(1)
    expect(host.current()).toBeNull()
  })

  test('a hub that never answers is stopped and reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const child = fakeProcess(7)
    const host = new LocalDeviceHost({
      stateDir: join(dir, 'state'),
      toolchain: installedToolchain(dir),
      run: nodeRun,
      spawn: () => { setTimeout(() => child.kill(), 10); return child },
      env: { PATH: '/opt/homebrew/bin' },
      hostPlatform: 'darwin',
      resolveNode: async () => ({ nodePath: '/fake/node' }),
      fetch: (async () => { throw new Error('refused') }) as unknown as typeof fetch,
      reservePort: async () => 45124,
    })
    await expect(host.ensureReady(() => {})).rejects.toThrow('waiting for the device hub')
    expect(host.current()).toBeNull()
  })

  test('an old Node is refused with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const run: DeviceCommandRunner = async () => ({ code: 0, stdout: 'v20.1.0', stderr: '' })
    const binDir = mkdtempSync(join(tmpdir(), 'solus-node-'))
    writeFileSync(join(binDir, 'node'), '')
    const host = new LocalDeviceHost({
      stateDir: join(dir, 'state'),
      toolchain: installedToolchain(dir),
      run,
      spawn: () => fakeProcess(1),
      env: { PATH: binDir },
      hostPlatform: 'darwin',
    })
    await expect(host.ensureReady(() => {})).rejects.toThrow('Node.js 22.12')
  })
})
