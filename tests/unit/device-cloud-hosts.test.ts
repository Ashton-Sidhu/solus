import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { cloudDeviceHostConfigSchema, type DeviceSummary, type SimlockDeviceHostConfig } from '@solus/contracts/device-types'
import { SimlockDeviceHost, simlockToken } from '@solus/server/devices/simlock-device-host'
import { DeviceToolchain } from '@solus/server/devices/device-toolchain'
import { DeviceHubProxy } from '@solus/server/devices/device-hub-proxy'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'solus-cloud-device-')); directories.push(path); return path }
const simlock: SimlockDeviceHostConfig = { kind: 'simlock', id: 'pool', label: 'Pool', gatewayUrl: 'https://gateway.test', agentToken: 'pool-secret', maxLeases: 1, maxLeaseMinutes: 60 }
const ios: DeviceSummary = { deviceHostId: simlock.id, deviceId: 'pool-ios', name: 'iPhone', version: 'Cloud', platform: 'ios', booted: false, physical: false }
describe('cloud device settings', () => {
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

test('cloud proxy supplies credentials on the host and only permits video routes', async () => {
  const received: { url: string; auth: string | undefined }[] = []
  const server = createServer((req, res) => {
    received.push({ url: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'video/h264')
    res.end('video-data')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  const proxy = new DeviceHubProxy({ hubOrigin: async () => { throw new Error('Cloud has no hub') }, upstream: async (_target, route) => route === 'video.avcc' ? { url: `${origin}/${route}`, headers: { authorization: 'Bearer preview-secret' } } : null, holdsControl: () => false, secret: () => Buffer.alloc(32) })
  try {
    const token = proxy.mint('client', { deviceHostId: 'pool', deviceId: 'session-1' }, 'ios').split('/').at(-1)!
    const video = await proxy.serve(token, 'video.avcc', new AbortController().signal)
    const body = await video.text()
    expect(body).toBe('video-data')
    expect(body).not.toContain('preview-secret')
    expect(received).toEqual([{ url: '/video.avcc', auth: 'Bearer preview-secret' }])
    expect((await proxy.serve(token, 'exec', new AbortController().signal)).status).toBe(404)
    expect((await proxy.serve(token, 'offer', new AbortController().signal, new Request(`${origin}/offer`, { method: 'POST', body: JSON.stringify({ command: 'whoami' }) }))).status).toBe(404)
    expect(received).toHaveLength(1)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

import { DeviceManager } from '@solus/server/devices/device-manager'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'

async function cloudManager() {
  const settings = new DeviceSettingsStore(join(await directory(), 'settings.json'))
  await settings.update({ enabled: true, cloudHosts: [simlock] })
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
    deviceHostId: simlock.id, kind: 'simlock',
    summary: async () => ({ deviceHostId: simlock.id, kind: 'simlock', label: 'Pool', platforms: [{ platform: 'ios', available: true }], hubInstalled: true, agentDeviceInstalled: true }),
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
    const first = await manager.open({ sessionId: 'one', deviceHostId: simlock.id, deviceId: 'pool-ios', platform: 'ios' }, 'user')
    await manager.open({ sessionId: 'two', deviceHostId: simlock.id, deviceId: first.deviceId, platform: 'ios' }, 'user')
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
  await expect(manager.saveCloudHost({ ...simlock, agentToken: 'replacement-token' })).rejects.toThrow('Cleanup not confirmed')
  expect(settings.get().cloudHosts?.[0]).toEqual(simlock)
  await expect(manager.removeCloudHost(simlock.id)).rejects.toThrow('Cleanup not confirmed')
  expect(settings.get().cloudHosts?.[0]).toEqual(simlock)
  await manager.dispose()
})


test('loading old device sources keeps saved Simlock pools and their credentials', async () => {
  const path = join(await directory(), 'settings.json')
  await writeFile(path, JSON.stringify({ enabled: true, cloudHosts: [{ kind: 'eas', id: 'old-source', label: 'Old source', appId: '1dbd623d-8794-4dfc-8a1b-6af10341fced', accessToken: '', maxSessionMinutes: 30, idleMinutes: 10, maxConcurrentSessions: 2 }, simlock] }))
  const settings = new DeviceSettingsStore(path)
  expect(settings.get().enabled).toBe(true)
  expect(settings.get().cloudHosts).toEqual([simlock])
  await settings.update({ autoShowAgentDevices: false })
  expect(JSON.parse(await readFile(path, 'utf8')).cloudHosts).toEqual([simlock])
})
