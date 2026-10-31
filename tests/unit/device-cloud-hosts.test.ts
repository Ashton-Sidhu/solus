import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { cloudDeviceHostConfigSchema, DEVICE_SECRET_SAVED, type DeviceSummary, type EasDeviceHostConfig, type SimlockDeviceHostConfig } from '@solus/contracts/device-types'
import { EasDeviceHost } from '@solus/server/devices/eas-device-host'
import { ExpoDeviceApi, ExpoDeviceApiError, type ExpoDeviceSession } from '@solus/server/devices/expo-device-api'
import { SimlockDeviceHost, simlockToken } from '@solus/server/devices/simlock-device-host'
import { DeviceToolchain } from '@solus/server/devices/device-toolchain'
import { DeviceHubProxy } from '@solus/server/devices/device-hub-proxy'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'solus-cloud-device-')); directories.push(path); return path }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const eas: EasDeviceHostConfig = { kind: 'eas', id: 'expo', label: 'Expo', appId: '1dbd623d-8794-4dfc-8a1b-6af10341fced', accessToken: 'expo-secret', maxSessionMinutes: 30, idleMinutes: 10, maxConcurrentSessions: 1 }
const simlock: SimlockDeviceHostConfig = { kind: 'simlock', id: 'pool', label: 'Pool', gatewayUrl: 'https://gateway.test', agentToken: 'pool-secret', maxLeases: 1, maxLeaseMinutes: 60 }
const ios: DeviceSummary = { deviceHostId: eas.id, deviceId: 'eas-ios', name: 'iPhone', version: 'Cloud', platform: 'ios', booted: false, physical: false }
class FakeExpo extends ExpoDeviceApi {
  created: { id: string; name: string; appId: string; maxRunTimeMinutes: number; maxIdleTimeMinutes: number }[] = []
  stopped: string[] = []
  activeSessions: { id: string; name: string; status: string }[] = []
  status = 'IN_PROGRESS'
  holdCreate: Promise<void> | null = null
  onCreate = () => {}
  override async check() { return [{ id: eas.appId, fullName: '@test/app' }] }
  override async create(input: Parameters<ExpoDeviceApi['create']>[0]) {
    const id = `session-${this.created.length + 1}`
    this.created.push({ id, ...input }); this.onCreate()
    if (this.holdCreate) await this.holdCreate
    return id
  }
  override async session(id: string): Promise<ExpoDeviceSession> {
    return { id, status: this.status, remoteConfig: { agentDeviceRemoteSessionUrl: 'https://agent.test', agentDeviceRemoteSessionToken: 'daemon-secret', previewApiUrl: 'https://preview.test', webPreviewToken: 'preview-secret' } }
  }
  override async active() { return this.activeSessions }
  override async stop(id: string) { this.stopped.push(id); return 'STOPPED' }
}
const previewFetch = (async () => Response.json({ device: 'REMOTE-UDID', serial: 'emulator-remote' })) as typeof fetch

async function expoHost(config = eas, api = new FakeExpo('')) {
  const path = join(await directory(), 'eas.json')
  const host = new EasDeviceHost(config, path, api, previewFetch)
  return { host, api, path, ready: await host.ensureReady() }
}

describe('cloud device settings', () => {
  test('EAS refuses idle limits that could conceal a longer billed session', () => {
    expect(cloudDeviceHostConfigSchema.safeParse({ ...eas, idleMinutes: 30 }).success).toBe(false)
    expect(cloudDeviceHostConfigSchema.safeParse({ ...eas, maxSessionMinutes: 116 }).success).toBe(false)
    expect(cloudDeviceHostConfigSchema.safeParse(eas).success).toBe(true)
  })
  test('a Simlock gateway is an origin, without embedded credentials or routes', () => {
    for (const gatewayUrl of ['', 'not-a-url', 'file:///tmp/pool', 'https://user:secret@gateway.test', 'https://gateway.test/path', 'https://gateway.test?token=secret']) expect(cloudDeviceHostConfigSchema.safeParse({ ...simlock, gatewayUrl }).success).toBe(false)
    expect(cloudDeviceHostConfigSchema.safeParse(simlock).success).toBe(true)
  })
  test('an ambient Simlock token is used only for its own gateway', () => {
    const env = { AGENT_DEVICE_DAEMON_BASE_URL: 'https://gateway.test/v1/agent-device', AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'env-secret' }
    expect(simlockToken({ ...simlock, agentToken: '' }, env)).toBe('env-secret')
    expect(simlockToken({ ...simlock, gatewayUrl: 'https://other.test', agentToken: '' }, env)).toBe('')
  })
})

describe('EAS devices', () => {
  test('opening records ownership before billing, passes limits, and routes by session id', async () => {
    const { host, ready, api, path } = await expoHost()
    api.onCreate = () => { /* The assertion below reads the ledger inside create. */ }
    let recorded = false
    const original = api.create.bind(api)
    api.create = async (input) => { recorded = (await readFile(path, 'utf8')).includes(input.name); return original(input) }
    const id = await ready.devices!.boot(ios)
    expect(recorded).toBe(true)
    expect(api.created[0]).toMatchObject({ maxRunTimeMinutes: 30, maxIdleTimeMinutes: 10 })
    expect(ready.devices!.agentEndpoint(id)).toMatchObject({ deviceId: 'REMOTE-UDID', baseUrl: 'https://agent.test' })
    expect(ready.upstream!(id, 'video.avcc')).toMatchObject({ url: 'https://preview.test/helper/REMOTE-UDID/stream.avcc', headers: { authorization: 'Bearer preview-secret' } })
    expect(ready.upstream!(id, 'exec')).toBeNull()
    expect((await host.summary()).config.accessToken).toBe(DEVICE_SECRET_SAVED)
    expect(JSON.stringify(await host.summary())).not.toContain('expo-secret')
    await host.stop()
    expect(api.stopped).toEqual([id])
  })
  test('concurrent opens cannot exceed the paid session limit', async () => {
    const { host, ready, api } = await expoHost()
    const held = deferred<void>(); const created = deferred<void>()
    api.holdCreate = held.promise; api.onCreate = () => created.resolve()
    const first = ready.devices!.boot(ios)
    await created.promise
    await expect(ready.devices!.boot(ios)).rejects.toThrow('limit')
    held.resolve(); await first
    expect(api.created).toHaveLength(1)
    await host.stop()
  })
  test('a stop during create cleans up the resulting session', async () => {
    const { host, ready, api } = await expoHost()
    const held = deferred<void>(); const created = deferred<void>()
    api.holdCreate = held.promise; api.onCreate = () => created.resolve()
    const opening = ready.devices!.boot(ios)
    await created.promise
    const stopped = host.stop()
    held.resolve()
    await expect(opening).rejects.toThrow('Could not start')
    await stopped
    expect(api.stopped).toContain('session-1')
    expect((await ready.devices!.list()).some((device) => device.booted)).toBe(false)
  })
  test('restart recovery stops only names in its ledger, including an uncertain create', async () => {
    const path = join(await directory(), 'ledger.json')
    await writeFile(path, JSON.stringify([{ name: 'solus-owned', appId: eas.appId }]))
    const api = new FakeExpo('')
    api.activeSessions = [{ id: 'owned-id', name: 'solus-owned', status: 'IN_PROGRESS' }, { id: 'outside-id', name: 'another-tool', status: 'IN_PROGRESS' }]
    const host = new EasDeviceHost(eas, path, api, previewFetch)
    await host.recover()
    expect(api.stopped).toEqual(['owned-id'])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  })
  test('a definite create refusal frees its slot, while unconfirmed stops keep ownership', async () => {
    const { host, ready, api, path } = await expoHost()
    const create = api.create.bind(api)
    api.create = async () => { throw new ExpoDeviceApiError('Account refused this start.', true) }
    await expect(ready.devices!.boot(ios)).rejects.toThrow('Could not start')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    api.create = create
    const id = await ready.devices!.boot(ios)
    api.stop = async () => 'IN_PROGRESS'
    await expect(host.stop()).rejects.toThrow('not confirmed')
    expect(JSON.parse(await readFile(path, 'utf8'))[0].id).toBe(id)
    api.stop = async () => 'STOPPED'
    await host.stop()
  })

  test('an uncertain create keeps its prewritten name for restart cleanup', async () => {
    const { ready, api, path } = await expoHost()
    api.create = async () => { throw new Error('Connection lost after sending create') }
    await expect(ready.devices!.boot(ios)).rejects.toThrow('Could not start')
    const records = JSON.parse(await readFile(path, 'utf8')) as { name: string; appId: string }[]
    expect(records).toHaveLength(1)
    api.activeSessions = [{ id: 'late-session', name: records[0]!.name, status: 'QUEUED' }]
    const recovered = new EasDeviceHost(eas, path, api, previewFetch)
    await recovered.recover()
    expect(api.stopped).toEqual(['late-session'])
  })

  test('Expo expiry drops its device and daemon endpoint on the next refresh', async () => {
    const { host, ready, api } = await expoHost()
    const id = await ready.devices!.boot(ios)
    api.status = 'ERRORED'
    expect((await ready.devices!.list()).some((device) => device.deviceId === id)).toBe(false)
    expect(ready.devices!.agentEndpoint(id)).toBeNull()
    await host.stop()
  })
})

class FakeToolchain extends DeviceToolchain {
  override async ensure() { return { installDir: '/test', entryPath: '/test/agent-device.mjs', sentinelPath: '/test/sentinel' } }
}
async function poolHost() {
  const dir = await directory()
  const commands: string[][] = []
  const run: DeviceCommandRunner = async (_command, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'v24.0.0', stderr: '' }
    commands.push([...args])
    if (args[1] === 'open') {
      const configPath = args[args.indexOf('--config') + 1]!
      const session = args[args.indexOf('--session') + 1]!
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { stateDir: string }
      await mkdir(join(config.stateDir, 'remote-connections'), { recursive: true })
      await writeFile(join(config.stateDir, 'remote-connections', `${session}.json`), JSON.stringify({ leaseId: 'lease-1' }))
    }
    return { code: 0, stdout: '{}', stderr: '' }
  }
  const requests: string[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method} ${url}`)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer pool-secret')
    return Response.json({ platforms: [{ platform: 'android', modelRuntimes: { 'Pixel 9': ['36'] }, modelClasses: { 'Pixel 9': 'phone' } }] })
  }) as typeof fetch
  const host = new SimlockDeviceHost(simlock, dir, new FakeToolchain(dir, run), run, fetchImpl)
  return { host, commands, requests }
}

describe('Simlock leases', () => {
  test('uses agent-device to allocate the lease and shares its session for agent control', async () => {
    const { host, commands } = await poolHost()
    const ready = await host.ensureReady()
    const device = (await ready.devices!.list())[0]!
    const id = await ready.devices!.boot(device)
    expect(commands[0]!.slice(1, 3)).toEqual(['connect', 'proxy'])
    expect(commands[1]!.slice(1, 6)).toEqual(['open', '--platform', 'android', '--device', 'Pixel 9'])
    const endpoint = ready.devices!.agentEndpoint(id)!
    expect(endpoint.deviceId).toBeNull()
    expect(endpoint.session).toStartWith('solus-')
    expect(endpoint.stateDir).toBe(endpoint.installDirectory)
    expect(ready.serveSimOnly).toBe(true)
    expect(ready.upstream!(id, 'video.avcc')?.url).toBe('https://gateway.test/v1/leases/lease-1/stream')
    expect(ready.upstream!(id, 'socket')?.url).toBe('https://gateway.test/v1/leases/lease-1/input')
    expect(ready.upstream!(id, 'video.mjpeg')).toBeNull()
    await expect(ready.devices!.boot(device)).rejects.toThrow('limit')
    await host.stop()
    expect(commands.at(-1)![1]).toBe('close')
    expect(ready.devices!.agentEndpoint(id)).toBeNull()
  })
})

test('cloud proxy supplies credentials on the host and never exposes preview shell tokens', async () => {
  const received: { url: string; auth: string | undefined }[] = []
  const server = createServer((req, res) => {
    received.push({ url: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ token: 'shell-secret', streamSettings: { transport: 'webrtc', iceServers: [{ urls: 'stun:stun.test' }] } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  const proxy = new DeviceHubProxy({ hubOrigin: async () => { throw new Error('Cloud has no hub') }, upstream: async (_target, route) => ['config', 'offer'].includes(route) ? { url: `${origin}/${route}`, headers: { authorization: 'Bearer preview-secret' } } : null, holdsControl: () => false, secret: () => Buffer.alloc(32) })
  try {
    const token = proxy.mint('client', { deviceHostId: 'expo', deviceId: 'session-1' }, 'ios').split('/').at(-1)!
    const config = await proxy.serve(token, 'config', new AbortController().signal)
    const body = await config.text()
    expect(body).toContain('webrtc')
    expect(body).not.toContain('shell-secret')
    expect(body).not.toContain('preview-secret')
    expect(received).toEqual([{ url: '/config', auth: 'Bearer preview-secret' }])
    expect((await proxy.serve(token, 'exec', new AbortController().signal)).status).toBe(404)
    expect((await proxy.serve(token, 'offer', new AbortController().signal, new Request(`${origin}/offer`, { method: 'POST', body: JSON.stringify({ command: 'whoami' }) }))).status).toBe(400)
    expect(received).toHaveLength(1)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

import { DeviceManager } from '@solus/server/devices/device-manager'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'

async function cloudManager() {
  const settings = new DeviceSettingsStore(join(await directory(), 'settings.json'))
  await settings.update({ enabled: true, cloudHosts: [eas] })
  let running = false
  let stops = 0
  let shutdowns = 0
  let refuseStop = false
  const ready: DeviceHostReady = {
    hubOrigin: '', nodePath: '', helpers: { serveSimAxSettings: null, serveSimCli: null }, run: async () => { throw new Error('Cloud devices must not run host commands') },
    devices: {
      list: async () => [ios, ...(running ? [{ ...ios, deviceId: 'session-1', booted: true }] : [])],
      boot: async () => { running = true; return 'session-1' },
      shutdown: async () => { shutdowns++; running = false },
      screenshot: async () => new Uint8Array(), agentEndpoint: () => ({ baseUrl: 'https://agent.test', token: 'secret' }),
    },
  }
  const cloud: DeviceHost = {
    deviceHostId: eas.id, kind: 'eas',
    summary: async () => ({ deviceHostId: eas.id, kind: 'eas', label: 'Expo', platforms: [{ platform: 'ios', available: true }], hubInstalled: true, agentDeviceInstalled: true }),
    platformAvailability: async (platform) => ({ platform, available: platform === 'ios' }),
    ensureReady: async () => ready, ensureAgentReady: async () => ({ ...ready, agentDevice: null }), current: () => ready,
    updateTool: async () => {}, stopAgent: async () => {}, stop: async () => { stops++; if (refuseStop) throw new Error('Cleanup not confirmed'); running = false },
  }
  const local: DeviceHost = { ...cloud, deviceHostId: 'local', kind: 'local', summary: async () => ({ deviceHostId: 'local', kind: 'local', label: 'Local', platforms: [], hubInstalled: false, agentDeviceInstalled: false }) }
  const manager = new DeviceManager({ settings, localHost: local, makeCloudHost: () => cloud, publish: () => {}, surfaceRequested: () => {}, storeImage: async () => ({ assetId: 'image' }) })
  await manager.start()
  return { manager, settings, stopped: () => stops, shutdowns: () => shutdowns, refuseStop: () => { refuseStop = true } }
}

test('cloud preview close releases a device only after its last session closes', async () => {
  const { manager, shutdowns } = await cloudManager()
  try {
    const first = await manager.open({ sessionId: 'one', deviceHostId: eas.id, deviceId: 'eas-ios', platform: 'ios' }, 'user')
    await manager.open({ sessionId: 'two', deviceHostId: eas.id, deviceId: first.deviceId, platform: 'ios' }, 'user')
    expect(manager.state().settings).not.toHaveProperty('cloudHosts')
    await manager.close({ sessionId: 'one' })
    expect(shutdowns()).toBe(0)
    await manager.close({ sessionId: 'two' })
    expect(shutdowns()).toBe(1)
    expect(manager.state().previews).toHaveLength(0)
  } finally { await manager.dispose() }
})

test('a failed cloud cleanup preserves its saved credential and configuration', async () => {
  const { manager, settings, refuseStop } = await cloudManager()
  refuseStop()
  await expect(manager.saveCloudHost({ ...eas, accessToken: 'replacement-token' })).rejects.toThrow('Cleanup not confirmed')
  expect(settings.get().cloudHosts?.[0]).toEqual(eas)
  await expect(manager.removeCloudHost(eas.id)).rejects.toThrow('Cleanup not confirmed')
  expect(settings.get().cloudHosts?.[0]).toEqual(eas)
  await manager.dispose()
})
