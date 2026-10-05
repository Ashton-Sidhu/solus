import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceHostSummary, DeviceState, SshDeviceHostConfig } from '@solus/contracts/device-types'
import { DeviceManager } from '@solus/server/devices/device-manager'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'
import { DeviceHubClient } from '@solus/server/devices/device-hub-client'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'
import { DeviceDomainError } from '@solus/server/devices/device-errors'

/**
 * The device manager is the one owner of device state. These tests encode
 * the lifecycle rules: nothing installs or starts before setup, closing a
 * preview never powers a device off, turning the hub off stops helpers but
 * not devices, and an old host instance can never publish.
 */

interface FakeHost extends DeviceHost {
  starts: number
  stops: number
  agentStops: number
}

function fakeHost(deviceHostId = 'local', kind: 'local' | 'ssh' = 'local', origin = `http://hub-${deviceHostId}`): FakeHost {
  const ready: DeviceHostReady = {
    hubOrigin: origin,
    nodePath: '/usr/bin/node',
    run: async (command, args) => (command === 'emulator' && args[0] === '-list-avds'
      ? { code: 0, stdout: 'Pixel_9\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  }
  let running = false
  const summary: DeviceHostSummary = {
    deviceHostId,
    kind,
    label: deviceHostId,
    platforms: [{ platform: 'ios', available: true }, { platform: 'android', available: true }],
    hubInstalled: true,
    agentDeviceInstalled: false,
  }
  const host: FakeHost = {
    deviceHostId,
    kind,
    starts: 0,
    stops: 0,
    agentStops: 0,
    summary: async () => summary,
    platformAvailability: async (platform) => summary.platforms.find((entry) => entry.platform === platform)!,
    ensureReady: async (onPhase) => {
      if (!running) {
        host.starts++
        onPhase('starting')
        running = true
      }
      return ready
    },
    ensureAgentReady: async (onPhase) => ({ ...(await host.ensureReady(onPhase)), agentDevice: { baseUrl: 'http://agent', token: 't' } }),
    current: () => (running ? ready : null),
    updateTool: async () => {},
    stopAgent: async () => { host.agentStops++ },
    stop: async () => { host.stops++; running = false },
  }
  return host
}

const PNG_2x3 = (() => {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x89504e47)
  view.setUint32(4, 0x0d0a1a0a)
  view.setUint32(12, 0x49484452)
  view.setUint32(16, 2)
  view.setUint32(20, 3)
  return bytes
})()

function hubFetch(state: { booted: Set<string>; requests: string[] }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    state.requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    if (url.endsWith('/api/devices')) {
      return Response.json({
        simulators: [{ id: 'SIM-1', name: 'iPhone 16', version: 'iOS 18.0', platform: 'ios', booted: state.booted.has('SIM-1'), physical: false }],
        emulators: state.booted.has('emulator-5554')
          ? [{ id: 'emulator-5554', name: 'Pixel_9', version: 'Android 15', platform: 'android', booted: true, physical: false }]
          : [],
        errors: [{ message: 'line one\n    at stack /Users/someone/secret' }],
      })
    }
    if (url.endsWith('/api/devices/boot')) {
      const body = JSON.parse(String(init?.body)) as { id: string; platform: string }
      if (body.platform === 'android') {
        state.booted.add('emulator-5554')
        return Response.json({ ok: true, serial: 'emulator-5554' })
      }
      state.booted.add(body.id)
      return Response.json({ ok: true, id: body.id })
    }
    if (url.includes('/grid/api/start')) return Response.json({ ok: true })
    if (url.includes('/api/screenshot')) return new Response(PNG_2x3)
    if (url.includes('/grid/api/shutdown') || url.endsWith('/api/devices/shutdown')) {
      state.booted.clear()
      return Response.json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

function setup(options: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'solus-devices-'))
  const settings = new DeviceSettingsStore(join(dir, 'settings.json'))
  const hubState = { booted: new Set<string>(), requests: [] as string[] }
  const host = fakeHost()
  const published: DeviceState[] = []
  const surfaces: string[] = []
  const sshHosts = new Map<string, FakeHost>()
  const stored: Buffer[] = []
  const manager = new DeviceManager({
    settings,
    localHost: host,
    hub: new DeviceHubClient(hubFetch(hubState)),
    makeSshHost: (config: SshDeviceHostConfig) => {
      const ssh = fakeHost(config.id, 'ssh')
      sshHosts.set(`${config.id}:${config.target}`, ssh)
      return ssh
    },
    isLocalSshTarget: async (config) => config.target === 'localhost',
    publish: (state) => published.push(state),
    surfaceRequested: (payload) => surfaces.push(`${payload.sessionId}:${payload.openedBy}`),
    storeImage: async (bytes) => { stored.push(bytes); return { assetId: 'abc.png' } },
  })
  const ready = options.enabled ? manager.configure({ enabled: true, onboardingCompleted: true }) : Promise.resolve(manager.state())
  return { manager, host, hubState, published, surfaces, sshHosts, ready, stored }
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof DeviceDomainError ? error.code : String(error)
  }
}

describe('device manager', () => {
  test('nothing starts before setup enables device support', async () => {
    // WHY: opening setup must install and start nothing (P01).
    const { manager, host } = setup()
    const state = await manager.list()
    expect(host.starts).toBe(0)
    expect(state.hostStatuses).toEqual([{ deviceHostId: 'local', status: 'disabled' }])
    expect(await errorCode(manager.readiness())).toBe('feature_disabled')
  })

  test('enabling discovers devices and AVDs, with bounded error detail', async () => {
    const { manager, ready } = setup({ enabled: true })
    const state = await ready
    expect(state.devices.map((device) => `${device.platform}:${device.deviceId}:${device.booted}`)).toEqual([
      'ios:SIM-1:false',
      'android:Pixel_9:false',
    ])
    const detail = state.hostStatuses.find((entry) => entry.deviceHostId === 'local')?.detail ?? ''
    // Hub errors carry stack traces with host paths; only the first line travels.
    expect(detail).toBe('line one')
    expect(manager.state().settings.enabled).toBe(true)
  })

  test('opening a stopped device boots it, attaches iOS capture and requests the surface', async () => {
    const { manager, ready, hubState, surfaces } = setup({ enabled: true })
    await ready
    const preview = await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'agent')
    expect(hubState.requests).toContain('POST /api/devices/boot')
    expect(hubState.requests).toContain('POST /vendor/serve-sim/grid/api/start')
    expect(manager.findDevice('local', 'SIM-1')?.booted).toBe(true)
    expect(manager.state().previews).toEqual([preview])
    expect(manager.state().booting).toEqual([])
    expect(surfaces).toEqual(['s1:agent'])
  })

  test('an AVD name becomes its serial without a duplicate preview', async () => {
    // WHY: an unbooted AVD is named by AVD; once running it is an emulator serial.
    const { manager, ready } = setup({ enabled: true })
    await ready
    const first = await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'Pixel_9', platform: 'android' }, 'user')
    expect(first.deviceId).toBe('emulator-5554')
    const again = await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'emulator-5554', platform: 'android' }, 'user')
    expect(again.devicePreviewId).toBe(first.devicePreviewId)
    expect(manager.state().previews).toHaveLength(1)
  })

  test('closing a preview never powers the device off', async () => {
    const { manager, ready, hubState } = setup({ enabled: true })
    await ready
    await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    manager.close({ sessionId: 's1' })
    expect(manager.state().previews).toEqual([])
    expect(hubState.booted.has('SIM-1')).toBe(true)
    expect(hubState.requests.some((request) => request.includes('shutdown'))).toBe(false)
  })

  test('shutdown ends every session preview of that device', async () => {
    const { manager, ready } = setup({ enabled: true })
    await ready
    await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    await manager.open({ sessionId: 's2', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    await manager.shutdown({ deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' })
    expect(manager.state().previews).toEqual([])
    expect(manager.findDevice('local', 'SIM-1')?.booted).toBe(false)
  })

  test('turning device support off stops helpers and clears previews, not devices', async () => {
    const { manager, ready, host, hubState } = setup({ enabled: true })
    await ready
    await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    const state = await manager.configure({ enabled: false })
    expect(host.stops).toBe(1)
    expect(state.previews).toEqual([])
    expect(state.devices).toEqual([])
    expect(hubState.booted.has('SIM-1')).toBe(true)
  })

  test('turning agent access off stops only the agent daemon', async () => {
    const { manager, ready, host } = setup({ enabled: true })
    await ready
    await manager.configure({ agentAccessEnabled: true })
    await manager.open({ sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    await manager.configure({ agentAccessEnabled: false })
    expect(host.agentStops).toBe(1)
    expect(host.stops).toBe(0)
    expect(manager.state().previews).toHaveLength(1)
    expect(await errorCode(manager.agentReadiness())).toBe('feature_disabled')
  })

  test('agent access is on by default and acts only once device support is turned on', async () => {
    const { manager, host } = setup()
    expect(manager.state().settings.agentAccessEnabled).toBe(true)
    expect(await errorCode(manager.agentReadiness())).toBe('feature_disabled')
    expect(host.starts).toBe(0)
    await manager.configure({ enabled: true })
    // Turning device support on starts the agent bridge too.
    expect(manager.agentEndpoint('local')).toEqual({ baseUrl: 'http://agent', token: 't' })
  })

  test('a person\'s choice to turn agent access off is kept, also across a device support toggle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-devices-'))
    const store = new DeviceSettingsStore(join(dir, 'settings.json'))
    await store.update({ enabled: true, agentAccessEnabled: false })
    expect(new DeviceSettingsStore(join(dir, 'settings.json')).get().agentAccessEnabled).toBe(false)

    const { manager, ready } = setup({ enabled: true })
    await ready
    await manager.configure({ agentAccessEnabled: false })
    await manager.configure({ enabled: false })
    await manager.configure({ enabled: true })
    expect(manager.state().settings.agentAccessEnabled).toBe(false)
    expect(manager.agentEndpoint('local')).toBeNull()
  })

  test('a settings file written before agent access existed reads it as on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-devices-'))
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ enabled: true }))
    expect(new DeviceSettingsStore(path).get().agentAccessEnabled).toBe(true)
  })

  test('the revision increases with every published change', async () => {
    const { published, ready } = setup({ enabled: true })
    await ready
    const revisions = published.map((state) => state.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
  })

  test('SSH hosts are added, a local alias is skipped, and an edit drops old previews', async () => {
    const { manager, ready, sshHosts } = setup({ enabled: true })
    await ready
    await manager.saveSshHosts([
      { id: 'mac', label: 'Studio Mac', target: 'studio' },
      { id: 'self', label: 'Self', target: 'localhost' },
    ])
    expect(manager.state().hosts.map((host) => host.deviceHostId).sort()).toEqual(['local', 'mac'])
    await manager.list()
    await manager.open({ sessionId: 's1', deviceHostId: 'mac', deviceId: 'SIM-1', platform: 'ios' }, 'user')
    expect(manager.state().previews.map((preview) => preview.deviceHostId)).toEqual(['mac'])
    await manager.saveSshHosts([{ id: 'mac', label: 'Studio Mac', target: 'studio-2' }])
    expect(sshHosts.get('mac:studio')?.stops).toBe(1)
    expect(manager.state().previews).toEqual([])
    expect(manager.state().devices.some((device) => device.deviceHostId === 'mac')).toBe(false)
  })

  test('the same device id on two hosts stays two devices', async () => {
    const { manager, ready } = setup({ enabled: true })
    await ready
    await manager.saveSshHosts([{ id: 'mac', label: 'Studio Mac', target: 'studio' }])
    await manager.list()
    const sims = manager.state().devices.filter((device) => device.deviceId === 'SIM-1')
    expect(sims.map((device) => device.deviceHostId).sort()).toEqual(['local', 'mac'])
  })

  test('a screenshot is stored as a host asset, never returned as a path', async () => {
    const { manager, ready, stored } = setup({ enabled: true })
    await ready
    const result = await manager.screenshot('local', 'SIM-1')
    expect(result.assetId).toBe('abc.png')
    expect([result.width, result.height]).toEqual([2, 3])
    expect(stored).toHaveLength(1)
    expect(await errorCode(manager.screenshot('local', 'missing'))).toBe('device_not_found')
  })
})

describe('simctl discovery', () => {
  test('never-booted simulators are listed, which the hub alone hides', async () => {
    // WHY: on a fresh Xcode install every simulator is unused, and the hub
    // lists none of them; the picker would be empty (found in the stage 0 run).
    const { parseSimctlDevices } = await import('@solus/server/devices/device-hub-client')
    const stdout = JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'A', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
        { udid: 'B', name: 'Old', state: 'Shutdown', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'W', name: 'Watch', state: 'Shutdown', isAvailable: true }],
    } })
    expect(parseSimctlDevices(stdout, 'local')).toEqual([
      { deviceHostId: 'local', deviceId: 'A', platform: 'ios', name: 'iPhone 17', version: 'iOS 26.5', booted: false, physical: false },
    ])
    expect(parseSimctlDevices('not json', 'local')).toEqual([])
  })
})

describe('hub discovery errors', () => {
  test('errors from a platform that is not installed are hidden; others are kept', async () => {
    // WHY: with no Android SDK, the platform reason already says so. The hub's
    // raw "[android-utils] Failed to run avdmanager" line was noise in setup.
    const hub = new DeviceHubClient((async () => Response.json({
      simulators: [],
      emulators: [],
      errors: [
        { message: '[android-utils] Failed to run `avdmanager list avd`:' },
        { message: '[apple-utils] Failed to run `xcrun simctl list devices --json`:' },
      ],
    })) as unknown as typeof fetch)
    expect((await hub.listDevices('http://hub', 'local', ['android'])).detail).toBe('[apple-utils] Failed to run `xcrun simctl list devices --json`:')
    expect((await hub.listDevices('http://hub', 'local', ['android', 'ios'])).detail).toBeUndefined()
  })
})
