import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from '@solus/contracts/device-types'
import { LocalDeviceHost } from '@solus/server/devices/local-device-host'
import { DeviceBuildStore } from '@solus/server/devices/device-builds'
import { DeviceHubClient } from '@solus/server/devices/device-hub-client'
import { DeviceManager } from '@solus/server/devices/device-manager'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'
import { DeviceToolchain } from '@solus/server/devices/device-toolchain'
import { findAndroidSdk, iosUnavailableReason, probePlatform } from '@solus/server/devices/device-platform-probe'
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
    writeFileSync(paths.sentinelPath, `${tool === 'hub' ? DEVICE_HUB_VERSION : AGENT_DEVICE_VERSION}\n`)
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

  test('Android tools in ANDROID_HOME can be checked separately', () => {
    // The probe joins with the host's separator; the tool names follow hostPlatform.
    const present = new Set([join('/sdk', 'platform-tools', 'adb'), join('/sdk', 'emulator', 'emulator')])
    const sdk = findAndroidSdk({ env: { ANDROID_HOME: '/sdk' }, hostPlatform: 'darwin', exists: (path) => present.has(path) })
    expect(sdk).toEqual({ root: '/sdk', adb: true, emulator: true, avdmanager: false })
  })

  test('standalone adb on PATH can provide Android support', async () => {
    const deps = { env: {}, hostPlatform: 'linux' as const, exists: () => false }
    const run: DeviceCommandRunner = async (command, args) => ({
      code: command === 'adb' && args[0] === 'version' ? 0 : 1, stdout: '', stderr: '',
    })
    expect(await probePlatform('android', { ...deps, run })).toEqual({ platform: 'android', available: true })
    expect(await probePlatform('android', {
      ...deps, run: async () => ({ code: 127, stdout: '', stderr: '' }),
    })).toMatchObject({ available: false, reason: expect.stringContaining('Platform-Tools') })
  })
})

describe('local device host', () => {
  test('Platform-Tools alone discover a USB phone and install an APK by serial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const sdk = join(dir, 'sdk')
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true })
    writeFileSync(join(sdk, 'platform-tools', 'adb'), '')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: true }))
    const apk = join(dir, 'app.apk')
    writeFileSync(apk, 'APK fixture')
    const commands: string[][] = []
    let adbFails = false
    const run: DeviceCommandRunner = async (command, args, options) => {
      commands.push([command, ...args])
      if (command === 'adb') expect(options?.env?.PATH?.split(delimiter)[0]).toBe(join(sdk, 'platform-tools'))
      if (command === 'adb' && args[0] === 'devices') {
        if (adbFails) return { code: 1, stdout: '', stderr: 'adb server failed' }
        return { code: 0, stdout: 'List of devices attached\nUSB123 device usb:1-1 model:Pixel_9\nLOCKED unauthorized usb:1-2\nemulator-5554 device\n', stderr: '' }
      }
      return nodeRun(command, args)
    }
    const host = new LocalDeviceHost({
      stateDir: join(dir, 'state'),
      toolchain: installedToolchain(dir),
      run,
      spawn: () => fakeProcess(4242),
      env: { ANDROID_HOME: sdk, PATH: '' },
      hostPlatform: 'linux',
      resolveNode: async () => ({ nodePath: '/fake/node' }),
      fetch: async () => new Response('ok'),
      reservePort: async () => 45123,
    })
    const hubRequests: string[] = []
    const manager = new DeviceManager({
      settings: new DeviceSettingsStore(join(dir, 'settings.json')),
      localHost: host,
      hub: new DeviceHubClient(async (input) => {
        hubRequests.push(new URL(String(input)).pathname)
        return Response.json({
          simulators: [],
          emulators: [{ id: 'emulator-5554', name: 'Pixel AVD', version: 'Android', platform: 'android', booted: true, physical: false }],
          errors: [{ message: '[android-utils] Failed to run avdmanager' }],
        })
      }),
      builds: new DeviceBuildStore({ path: join(dir, 'builds.json'), assetsDir: join(dir, 'assets'), run }),
      publish: () => {},
      surfaceRequested: () => {},
      storeImage: async () => ({ assetId: 'fixture.png' }),
    })
    try {
      const state = await manager.list()
      expect(state.hosts[0]?.platforms).toContainEqual({ platform: 'android', available: true })
      expect(state.devices.map((device) => device.deviceId)).toEqual(['USB123', 'LOCKED'])
      expect(state.devices[1]?.unavailableReason).toContain('USB debugging')
      expect(state.hostStatuses[0]?.detail).toBeUndefined()

      const build = await manager.addBuild(apk, 'session', 'dev.solus.fixture')
      const user = { kind: 'user' as const, clientId: 'client', label: 'User' }
      const target = { deviceHostId: 'local', deviceId: 'USB123' }
      manager.control.acquireForUser(target, user)
      const installed = await manager.installBuild(target, build.buildId, user, false)
      expect(installed.build.lastInstall?.deviceId).toBe('USB123')
      expect(installed.device).toMatchObject({ physical: true, platform: 'android', booted: true })
      expect(commands).toEqual([
        ['adb', 'devices', '-l'],
        ['adb', '-s', 'USB123', 'install', '-r', build.path],
      ])
      expect(hubRequests).toEqual(['/api/devices'])
      await expect(manager.shutdown({ deviceHostId: 'local', deviceId: 'emulator-5554', platform: 'android' }))
        .rejects.toMatchObject({ code: 'platform_unavailable' })
      expect(hubRequests).toEqual(['/api/devices'])

      adbFails = true
      const failed = await manager.list()
      expect(failed.devices).toEqual([])
      expect(failed.hostStatuses[0]?.detail).toBe('Could not list connected Android devices with adb.')
    } finally {
      await host.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  test('an upgrade leaves the old daemon record for agent-device to retire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const stateDir = join(dir, 'state')
    const daemonFile = join(stateDir, 'agent-device', 'daemon.json')
    const oldDaemon = { httpPort: 45000, token: 'old-token', version: '0.21.31' }
    mkdirSync(join(stateDir, 'agent-device'), { recursive: true })
    writeFileSync(daemonFile, JSON.stringify(oldDaemon))
    const child = fakeProcess(9)
    const run: DeviceCommandRunner = async (command, args) => {
      if (args[1] !== 'devices') return nodeRun(command, args)
      expect(JSON.parse(readFileSync(daemonFile, 'utf8'))).toEqual(oldDaemon)
      writeFileSync(daemonFile, JSON.stringify({ httpPort: 45001, token: 'new-token', version: AGENT_DEVICE_VERSION }))
      return { code: 0, stdout: '', stderr: '' }
    }
    const host = new LocalDeviceHost({
      stateDir,
      toolchain: installedToolchain(dir),
      run,
      spawn: () => child,
      env: { PATH: '' },
      resolveNode: async () => ({ nodePath: '/fake/node' }),
      fetch: async () => new Response('ok'),
      reservePort: async () => 45123,
    })
    try {
      const ready = await host.ensureAgentReady(() => {})
      expect(ready.agentDevice).toEqual({ baseUrl: 'http://127.0.0.1:45001', token: 'new-token' })
    } finally {
      await host.stop()
    }
  })

  test('an old Node is refused with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    const run: DeviceCommandRunner = async () => ({ code: 0, stdout: 'v20.1.0', stderr: '' })
    const binDir = mkdtempSync(join(tmpdir(), 'solus-node-'))
    writeFileSync(join(binDir, process.platform === 'win32' ? 'node.exe' : 'node'), '')
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
