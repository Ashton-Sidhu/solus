import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceBuildFits, type DeviceBuild, type DeviceHostSummary, type DeviceState, type DeviceSummary } from '@solus/contracts/device-types'
import { deviceBuildTargets, installDeviceBuild, isBuildOutput } from '@solus/client-core/device-builds'
import { DeviceBuildStore, explainInstallFailure, installBuild, installCommands, type StoredDeviceBuild } from '@solus/server/devices/device-builds'
import { DeviceDomainError } from '@solus/server/devices/device-errors'
import { DeviceHubClient } from '@solus/server/devices/device-hub-client'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'
import { DeviceManager } from '@solus/server/devices/device-manager'
import { parseAdbDevices, parseDevicectlDevices } from '@solus/server/devices/device-physical'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'

/**
 * Putting a dev build on a phone (plan 016, S02). The rules: a connected
 * phone says why it cannot take an install, a build goes only where it can
 * run, an install needs control of the device, and an APK is kept so a phone
 * can download it.
 */

const devicectlJson = JSON.stringify({
  info: { outcome: 'success' },
  result: {
    devices: [
      {
        identifier: 'CORE-1',
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
        deviceProperties: { name: 'Ash iPhone', osVersionNumber: '26.0', developerModeStatus: 'enabled' },
        hardwareProperties: { udid: '00008140-AAA', platform: 'iOS', deviceType: 'iPhone', reality: 'physical' },
      },
      {
        identifier: 'CORE-2',
        connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected' },
        deviceProperties: { name: 'Studio iPad', osVersionNumber: '26.0', developerModeStatus: 'disabled' },
        hardwareProperties: { udid: '00008140-BBB', platform: 'iOS', deviceType: 'iPad', reality: 'physical' },
      },
      {
        identifier: 'CORE-3',
        connectionProperties: { pairingState: 'unpaired', tunnelState: 'connected' },
        deviceProperties: { name: 'New iPhone' },
        hardwareProperties: { udid: '00008140-CCC', platform: 'iOS', deviceType: 'iPhone' },
      },
      {
        identifier: 'CORE-4',
        connectionProperties: { tunnelState: 'unavailable' },
        deviceProperties: { name: 'Old iPhone' },
        hardwareProperties: { udid: '00008140-DDD', platform: 'iOS', deviceType: 'iPhone' },
      },
      { identifier: 'WATCH', connectionProperties: {}, deviceProperties: { name: 'Watch' }, hardwareProperties: { platform: 'watchOS' } },
    ],
  },
})

const adbOutput = [
  'List of devices attached',
  'R58M123ABC             device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:2',
  '9B091FFAZ001           unauthorized usb:1-2 transport_id:3',
  'emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:1',
  '',
].join('\n')

const phone: DeviceSummary = { deviceHostId: 'local', deviceId: '00008140-AAA', platform: 'ios', name: 'Ash iPhone', version: 'iOS 26.0', booted: true, physical: true }
const simulator: DeviceSummary = { deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios', name: 'iPhone 17', version: 'iOS 26.0', booted: true, physical: false }
const pixel: DeviceSummary = { deviceHostId: 'local', deviceId: 'R58M123ABC', platform: 'android', name: 'SM G973F', version: 'Android', booted: true, physical: true }

function build(fields: Partial<DeviceBuild>): DeviceBuild {
  return { buildId: 'b1', platform: 'ios', runsOn: 'device', appId: 'dev.solus.demo', name: 'Demo.app', sessionId: 's1', sizeBytes: 1, createdAt: 0, assetId: null, lastInstall: null, ...fields }
}

describe('connected device discovery', () => {
  test('iPhones and iPads say why they cannot take an install', () => {
    const devices = parseDevicectlDevices(devicectlJson, 'local')
    expect(devices.map((device) => [device.deviceId, device.version, device.booted, device.physical])).toEqual([
      ['00008140-AAA', 'iOS 26.0', true, true],
      ['00008140-BBB', 'iPadOS 26.0', true, true],
      ['00008140-CCC', 'iOS', true, true],
      ['00008140-DDD', 'iOS', false, true],
    ])
    expect(devices[0]!.unavailableReason).toBeUndefined()
    expect(devices[1]!.unavailableReason).toContain('Developer Mode')
    expect(devices[2]!.unavailableReason).toContain('Trust')
    expect(devices[3]!.unavailableReason).toContain('not connected')
    expect(parseDevicectlDevices('not json', 'local')).toEqual([])
  })

  test('adb lists phones, not emulators, and flags an unauthorized one', () => {
    const devices = parseAdbDevices(adbOutput, 'local')
    expect(devices.map((device) => device.deviceId)).toEqual(['R58M123ABC', '9B091FFAZ001'])
    expect(devices[0]!.name).toBe('SM G973F')
    expect(devices[0]!.unavailableReason).toBeUndefined()
    expect(devices[1]!.unavailableReason).toContain('USB debugging')
  })
})

describe('which device a build fits', () => {
  test('a simulator build never goes on a phone, and a device build never on a simulator', () => {
    expect(deviceBuildFits(build({ runsOn: 'simulator' }), phone).fits).toBe(false)
    expect(deviceBuildFits(build({ runsOn: 'device' }), simulator).fits).toBe(false)
    expect(deviceBuildFits(build({ runsOn: 'device' }), phone).fits).toBe(true)
    expect(deviceBuildFits(build({ platform: 'android', runsOn: 'any' }), phone).fits).toBe(false)
  })

  test('a phone on an SSH device host or one that is not ready takes nothing', () => {
    // WHY: the build output lives on the Solus host; installs do not copy it to another machine yet.
    expect(deviceBuildFits(build({}), { ...phone, deviceHostId: 'studio' }).fits).toBe(false)
    const locked = deviceBuildFits(build({}), { ...phone, unavailableReason: 'Unlock it.' })
    expect(locked).toEqual({ fits: false, reason: 'Unlock it.' })
  })

  test('install targets list connected phones before simulators', () => {
    const state: DeviceState = { revision: 1, settings: { enabled: true, agentAccessEnabled: true, onboardingCompleted: true, autoShowAgentDevices: true }, hosts: [], hostStatuses: [], devices: [simulator, phone], previews: [], booting: [], controls: [], builds: [] }
    expect(deviceBuildTargets(state, build({ runsOn: 'any' })).map((device) => device.deviceId)).toEqual(['00008140-AAA', 'SIM-1'])
  })
})

describe('build store', () => {
  function plutilRunner(platform: 'iPhoneOS' | 'iPhoneSimulator'): DeviceCommandRunner {
    return async (_command, args) => args.includes('CFBundleIdentifier')
      ? { code: 0, stdout: 'dev.solus.demo\n', stderr: '' }
      : { code: 0, stdout: `["${platform}"]`, stderr: '' }
  }

  test('an APK is kept as a downloadable asset; the same output built again replaces its entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const apk = join(dir, 'app-debug.apk')
    writeFileSync(apk, 'apk bytes v1')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneOS'), assetsDir: join(dir, 'assets') })
    const first = await store.add(apk, 's1', 'dev.solus.demo')
    expect(first.platform).toBe('android')
    expect(first.assetId).toMatch(/^[a-f0-9]{64}\.apk$/)
    // WHY: the phone downloads the stored copy, so a later rebuild cannot change what was offered.
    writeFileSync(apk, 'apk bytes v2')
    expect(readFileSync(first.path, 'utf8')).toBe('apk bytes v1')
    const second = await store.add(apk, 's1', 'dev.solus.demo')
    expect(second.assetId).not.toBe(first.assetId)
    expect(store.list().map((entry) => entry.buildId)).toEqual([second.buildId, first.buildId])
    // The list never carries host paths to clients.
    expect(JSON.stringify(store.list())).not.toContain(dir)
    // Persisted: a restarted host still offers the builds.
    const reopened = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneOS'), assetsDir: join(dir, 'assets') })
    expect(reopened.list().map((entry) => entry.buildId)).toEqual([second.buildId, first.buildId])
  })

  test('an .app reads its bundle id and which iOS devices it runs on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const app = join(dir, 'Demo.app')
    mkdirSync(app)
    writeFileSync(join(app, 'Info.plist'), 'plist')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneSimulator') })
    const first = await store.add(app, 's1')
    expect([first.platform, first.runsOn, first.appId, first.assetId]).toEqual(['ios', 'simulator', 'dev.solus.demo', null])
    const again = await store.add(app, 's2')
    expect(store.list().map((entry) => entry.buildId)).toEqual([again.buildId])
  })

  test('a build whose output is gone is not offered, also after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const app = join(dir, 'Demo.app')
    mkdirSync(app)
    writeFileSync(join(app, 'Info.plist'), 'plist')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneSimulator') })
    const added = await store.add(app, 's1')
    rmSync(app, { recursive: true })
    // WHY: a row for a missing file can only fail when it is run.
    expect(store.list()).toEqual([])
    expect(() => store.get(added.buildId)).toThrow(DeviceDomainError)
    expect(new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneSimulator') }).list()).toEqual([])
  })

  test('deleting an .app removes that bundle and its entry, and nothing around it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const products = join(dir, 'Debug-iphonesimulator')
    const app = join(products, 'Demo.app')
    mkdirSync(join(app, 'Frameworks'), { recursive: true })
    writeFileSync(join(app, 'Info.plist'), 'plist')
    writeFileSync(join(products, 'Demo.swiftmodule'), 'sibling')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneSimulator') })
    const added = await store.add(app, 's1')

    await store.remove(added.buildId)

    expect(existsSync(app)).toBe(false)
    expect(readFileSync(join(products, 'Demo.swiftmodule'), 'utf8')).toBe('sibling')
    expect(store.list()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'builds.json'), 'utf8'))).toEqual([])
  })

  test('deleting a linked .app removes the link, not the bundle it points to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const real = join(dir, 'real', 'Demo.app')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'Info.plist'), 'plist')
    const link = join(dir, 'Linked.app')
    symlinkSync(real, link)
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneSimulator') })
    const added = await store.add(link, 's1')

    await store.remove(added.buildId)

    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(real, 'Info.plist'))).toBe(true)
  })

  test('deleting an APK removes the stored copy, not the project output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const apk = join(dir, 'app-debug.apk')
    writeFileSync(apk, 'apk bytes')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneOS'), assetsDir: join(dir, 'assets') })
    const added = await store.add(apk, 's1')

    await store.remove(added.buildId)

    expect(existsSync(added.path)).toBe(false)
    expect(readFileSync(apk, 'utf8')).toBe('apk bytes')
    expect(store.list()).toEqual([])
  })

  test('anything but an .app bundle or an .apk is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    writeFileSync(join(dir, 'Demo.ipa'), 'x')
    const store = new DeviceBuildStore({ path: join(dir, 'builds.json'), run: plutilRunner('iPhoneOS') })
    await expect(store.add(join(dir, 'Demo.ipa'), 's1')).rejects.toBeInstanceOf(DeviceDomainError)
    await expect(store.add(join(dir, 'missing.apk'), 's1')).rejects.toBeInstanceOf(DeviceDomainError)
  })
})

describe('installing', () => {
  const stored = (fields: Partial<StoredDeviceBuild>): StoredDeviceBuild => ({ ...build({}), path: '/tmp/Demo.app', ...fields })

  test('each kind of device gets its own install and launch commands', () => {
    expect(installCommands(stored({}), phone, true)).toEqual({
      install: ['xcrun', ['devicectl', 'device', 'install', 'app', '--device', '00008140-AAA', '/tmp/Demo.app']],
      launch: ['xcrun', ['devicectl', 'device', 'process', 'launch', '--device', '00008140-AAA', '--terminate-existing', 'dev.solus.demo']],
    })
    expect(installCommands(stored({ runsOn: 'simulator' }), simulator, true).install).toEqual(['xcrun', ['simctl', 'install', 'SIM-1', '/tmp/Demo.app']])
    const android = installCommands(stored({ platform: 'android', path: '/data/a.apk', appId: 'dev.solus.demo' }), pixel, true)
    expect(android.install).toEqual(['adb', ['-s', 'R58M123ABC', 'install', '-r', '/data/a.apk']])
    expect(android.launch?.[1]).toContain('monkey')
    expect(installCommands(stored({ appId: null }), phone, true).launch).toBeNull()
  })

  test('a signing failure tells the person how to fix it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const calls: string[] = []
    const run: DeviceCommandRunner = async (command, args) => {
      calls.push(`${command} ${args.slice(0, 3).join(' ')}`)
      return { code: 1, stdout: '', stderr: 'ERROR: The application could not be verified. (0xe8008015) A valid provisioning profile for this executable was not found.' }
    }
    const error = await installBuild(run, stored({ path: dir }), phone, true).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DeviceDomainError)
    expect((error as DeviceDomainError).detail).toContain('-allowProvisioningUpdates')
    // Nothing launches after a failed install.
    expect(calls).toEqual(['xcrun devicectl device install'])
    expect(explainInstallFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: ...]', pixel)).toContain('Uninstall')
  })
})

describe('device manager installs', () => {
  function hostWith(run: DeviceCommandRunner): DeviceHost {
    const ready: DeviceHostReady = { hubOrigin: 'http://hub', nodePath: '/usr/bin/node', run, helpers: { serveSimAxSettings: null, serveSimCli: null } }
    const summary: DeviceHostSummary = { deviceHostId: 'local', kind: 'local', label: 'This machine', platforms: [{ platform: 'ios', available: true }, { platform: 'android', available: false, reason: 'no SDK' }], hubInstalled: true, agentDeviceInstalled: false }
    return {
      deviceHostId: 'local',
      kind: 'local',
      summary: async () => summary,
      platformAvailability: async (platform) => summary.platforms.find((entry) => entry.platform === platform)!,
      ensureReady: async () => ready,
      ensureAgentReady: async () => ({ ...ready, agentDevice: { baseUrl: 'http://agent', token: 't' } }),
      current: () => ready,
      updateTool: async () => {},
      stopAgent: async () => {},
      stop: async () => {},
    }
  }

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'solus-builds-'))
    const app = join(dir, 'Demo.app')
    mkdirSync(app)
    const commands: string[] = []
    const run: DeviceCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(' '))
      if (command === 'sh') return { code: 0, stdout: devicectlJson, stderr: '' }
      if (command === 'plutil') return { code: 0, stdout: args.includes('CFBundleIdentifier') ? 'dev.solus.demo' : '["iPhoneOS"]', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const hubFetch = (async () => Response.json({ simulators: [], emulators: [], errors: [] })) as unknown as typeof fetch
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: true }))
    const manager = new DeviceManager({
      settings: new DeviceSettingsStore(join(dir, 'settings.json')),
      localHost: hostWith(run),
      hub: new DeviceHubClient(hubFetch),
      publish: () => {},
      surfaceRequested: () => {},
      storeImage: async () => ({ assetId: 'x.png' }),
      builds: new DeviceBuildStore({ path: join(dir, 'builds.json'), run }),
    })
    const state = await manager.list()
    const stored = await manager.addBuild(app, 's1')
    return { manager, state, stored, commands }
  }

  test('connected phones are listed but cannot be previewed', async () => {
    const { manager, state } = await setup()
    expect(state.devices.filter((device) => device.physical).map((device) => device.deviceId)).toContain('00008140-AAA')
    const error = await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: '00008140-AAA', platform: 'ios' }, 'user').catch((cause: unknown) => cause)
    expect((error as DeviceDomainError).code).toBe('action_unsupported')
  })

  test('an install needs control, goes only on a fitting device, and records where it went', async () => {
    const { manager, stored, commands } = await setup()
    const target = { deviceHostId: 'local', deviceId: '00008140-AAA' }
    const holder = { kind: 'agent' as const, sessionId: 's1', label: 'Claude agent' }
    // WHY: an install changes the device, so it follows the same lease as every other mutation.
    const unleased = await manager.installBuild(target, stored.buildId, holder).catch((cause: unknown) => cause)
    expect((unleased as DeviceDomainError).code).toBe('control_required')

    const notReady = { deviceHostId: 'local', deviceId: '00008140-BBB' }
    manager.control.acquireForAgent(notReady, holder)
    const refused = await manager.installBuild(notReady, stored.buildId, holder).catch((cause: unknown) => cause)
    expect((refused as DeviceDomainError).detail).toContain('Developer Mode')

    manager.control.acquireForAgent(target, holder)
    const result = await manager.installBuild(target, stored.buildId, holder)
    expect(result.launched).toBe(true)
    expect(commands.filter((command) => command.startsWith('xcrun devicectl device'))).toHaveLength(2)
    expect(manager.state().builds[0]!.lastInstall?.deviceName).toBe('Ash iPhone')
  })

  test('a deleted build leaves the snapshot every client reads', async () => {
    const { manager, stored } = await setup()
    const state = await manager.deleteBuild(stored.buildId)
    expect(state.builds).toEqual([])
    expect(existsSync(stored.path)).toBe(false)
    // A second delete, from a client still showing the row, says it is gone.
    const again = await manager.deleteBuild(stored.buildId).catch((cause: unknown) => cause)
    expect((again as DeviceDomainError).code).toBe('invalid_request')
  })
})

describe('choosing a build in a folder browser', () => {
  test('an .app bundle is a folder and an .apk is a file; nothing else is offered', () => {
    // WHY: the browser chooses an .app instead of opening it, so it must
    // recognize the bundle as the folder it is.
    expect(isBuildOutput({ name: 'Demo.app', isDir: true })).toBe(true)
    expect(isBuildOutput({ name: 'app-debug.apk', isDir: false })).toBe(true)
    expect(isBuildOutput({ name: 'Demo.app', isDir: false })).toBe(false)
    expect(isBuildOutput({ name: 'outputs.apk', isDir: true })).toBe(false)
    expect(isBuildOutput({ name: 'Debug-iphonesimulator', isDir: true })).toBe(false)
  })
})

describe('client install', () => {
  const control = { deviceHostId: 'local', deviceId: 'SIM-1', lease: null, agentPaused: false }

  test('a free device is borrowed for the install and given back', async () => {
    const calls: string[] = []
    const api = {
      deviceControlAcquire: async () => { calls.push('acquire'); return { lease: { deviceHostId: 'local', deviceId: 'SIM-1', holder: { kind: 'user' as const, clientId: 'c', label: 'Me' }, generation: 7, expiresAt: 0 }, control } },
      deviceInstall: async () => { calls.push('install'); return build({}) },
      deviceControlRelease: async () => { calls.push('release') },
    }
    await installDeviceBuild(api, { deviceHostId: 'local', deviceId: 'SIM-1' }, build({}), control, false)
    expect(calls).toEqual(['acquire', 'install', 'release'])
  })

  test('an install never takes a device from an agent that is using it', async () => {
    // WHY: a person installing a build must not interrupt an agent's test run.
    const busy = { ...control, lease: { deviceHostId: 'local', deviceId: 'SIM-1', holder: { kind: 'agent' as const, sessionId: 's2', label: 'Codex agent' }, generation: 3, expiresAt: 0 } }
    const api = {
      deviceControlAcquire: async () => { throw new Error('must not take control') },
      deviceInstall: async () => build({}),
      deviceControlRelease: async () => {},
    }
    await expect(installDeviceBuild(api, { deviceHostId: 'local', deviceId: 'SIM-1' }, build({}), busy, false)).rejects.toThrow('Codex agent is using this device')
  })
})
