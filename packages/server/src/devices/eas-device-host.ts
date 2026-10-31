// Adapted from T3 Code's EasDeviceHost.ts (MIT, pingdotgg/t3code).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEVICE_SECRET_SAVED, type DeviceSummary, type EasDeviceHostConfig, type DevicePlatform } from '@solus/contracts/device-types'
import type { AgentDeviceEndpoint, DeviceHost, DeviceHostReady } from './device-host'
import { ExpoDeviceApi, ExpoDeviceApiError } from './expo-device-api'

const ledgerSchema = z.array(z.object({ name: z.string(), appId: z.string(), id: z.string().optional(), recordedAt: z.number().default(() => Date.now()) }))
type LedgerEntry = z.infer<typeof ledgerSchema>[number]
interface RunningSession {
  device: DeviceSummary
  remoteDeviceId: string
  preview: { origin: string; token: string }
  agent: AgentDeviceEndpoint
}
const terminal = (status: string) => ['FINISHED', 'ERRORED', 'ERROR', 'CANCELED', 'CANCELLED', 'STOPPED'].includes(status)

export class EasDeviceHost implements DeviceHost {
  readonly kind = 'eas' as const
  readonly deviceHostId: string
  private ready: DeviceHostReady | null = null
  private readonly sessions = new Map<string, RunningSession>()
  private ledger: LedgerEntry[] = []
  private initialization: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly pending = new Set<string>()
  private epoch = 0
  private readonly starts = new Set<Promise<string>>()

  constructor(private readonly config: EasDeviceHostConfig, private readonly ledgerPath: string, private readonly api = new ExpoDeviceApi(config.accessToken), private readonly fetchImpl: typeof fetch = fetch, private readonly delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    this.deviceHostId = config.id
  }

  async summary() {
    return { deviceHostId: this.deviceHostId, kind: this.kind, label: this.config.label,
      config: { ...this.config, accessToken: this.config.accessToken ? DEVICE_SECRET_SAVED : '' },
      platforms: (['ios', 'android'] as const).map((platform) => ({ platform, available: true })), hubInstalled: true, agentDeviceInstalled: true }
  }
  async platformAvailability(platform: DevicePlatform) { return { platform, available: true } }

  private saveLedger(): Promise<void> {
    const content = JSON.stringify(this.ledger)
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.ledgerPath), { recursive: true, mode: 0o700 })
      const temporary = `${this.ledgerPath}.tmp`
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, this.ledgerPath)
    })
    this.writes = write.catch(() => {})
    return write
  }

  private initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      const stored = await readFile(this.ledgerPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '[]'
        throw new Error('Cannot read the EAS session ledger. Restore access before starting a session.')
      })
      this.ledger = ledgerSchema.parse(JSON.parse(stored))
      await this.reap()
    })().catch((error) => { this.initialization = null; throw error })
  }

  /** Names are written before create; an uncertain create remains recoverable after a crash. */
  private async reap(): Promise<void> {
    const pending = this.ledger.filter((entry) => !this.pending.has(entry.name) && (!entry.id || !this.sessions.has(entry.id)))
    if (!pending.length) return
    for (const entry of pending.filter((item) => item.id)) {
      const session = await this.api.session(entry.id!)
      if (!terminal(session.status) && !terminal(await this.api.stop(entry.id!))) throw new Error('Expo has not confirmed that an owned session stopped. Try again.')
      this.ledger = this.ledger.filter((item) => item !== entry)
    }
    for (const appId of new Set(pending.filter((entry) => !entry.id).map((entry) => entry.appId))) {
      const active = await this.api.active(appId)
      for (const entry of pending.filter((item) => !item.id && item.appId === appId)) {
        const found = active.find((session) => session.name === entry.name)
        if (found && !terminal(await this.api.stop(found.id))) throw new Error('Expo has not confirmed that an owned session stopped. Try again.')
        // Keep uncertain creates for recovery; an unobserved name ages out after a day.
        if (found || Date.now() - entry.recordedAt > 24 * 60 * 60_000) this.ledger = this.ledger.filter((item) => item !== entry)
      }
    }
    await this.saveLedger()
  }

  private async list(): Promise<DeviceSummary[]> {
    await this.initialize()
    for (const [id] of this.sessions) {
      const session = await this.api.session(id)
      if (terminal(session.status)) {
        this.sessions.delete(id)
        this.ledger = this.ledger.filter((entry) => entry.id !== id)
        await this.saveLedger()
      }
    }
    await this.reap()
    return [
      ...(['ios', 'android'] as const).map((platform) => ({ deviceHostId: this.deviceHostId, deviceId: `eas-${platform}`, platform, name: platform === 'ios' ? 'iPhone (EAS Simulator)' : 'Android (EAS Simulator)', version: 'Cloud', booted: false, physical: false })),
      ...[...this.sessions.values()].map((session) => session.device),
    ]
  }

  private async boot(device: DeviceSummary): Promise<string> {
    const epoch = this.epoch
    await this.initialize()
    if (epoch !== this.epoch) throw new Error('Device support stopped while the device was opening.')
    if (this.sessions.has(device.deviceId)) return device.deviceId
    if (device.deviceId !== `eas-${device.platform}`) throw new Error('This EAS session ended. Open a new device from the list.')
    if (this.ledger.filter((entry) => entry.id || Date.now() - entry.recordedAt < 5 * 60_000).length >= this.config.maxConcurrentSessions) throw new Error('The EAS session limit was reached. Stop an existing session first.')
    const entry: LedgerEntry = { name: `solus-${randomUUID()}`, appId: this.config.appId, recordedAt: Date.now() }
    this.pending.add(entry.name)
    this.ledger.push(entry)
    try {
      await this.saveLedger()
      entry.id = await this.api.create({ appId: entry.appId, name: entry.name, platform: device.platform, maxRunTimeMinutes: this.config.maxSessionMinutes, maxIdleTimeMinutes: this.config.idleMinutes })
      await this.saveLedger()
      const session = await this.waitForSession(entry.id, device, epoch)
      this.sessions.set(entry.id, session)
      return entry.id
    } catch (error) {
      if (!entry.id && error instanceof ExpoDeviceApiError && error.rejected) { this.ledger = this.ledger.filter((item) => item !== entry); await this.saveLedger() }
      if (entry.id) await this.shutdown(entry.id).catch(() => {})
      throw new Error('Could not start the EAS simulator. Check Expo access and capacity. Any pending session remains tracked for cleanup.')
    } finally { this.pending.delete(entry.name) }
  }

  private async waitForSession(id: string, device: DeviceSummary, epoch: number): Promise<RunningSession> {
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline && epoch === this.epoch) {
      const session = await this.api.session(id)
      if (terminal(session.status)) throw new Error('The EAS session ended before it became ready.')
      const remote = session.remoteConfig
      if (session.status === 'IN_PROGRESS' && remote?.previewApiUrl && remote.webPreviewToken) {
        const origin = new URL(remote.previewApiUrl).origin
        const prefix = device.platform === 'ios' ? '' : '/vendor/serve-emu'
        const response = await this.fetchImpl(`${origin}${prefix}/api`, { headers: { authorization: `Bearer ${remote.webPreviewToken}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
        if (!response?.ok) throw new Error('The EAS preview did not answer.')
        const parsed = z.object({ device: z.string().optional(), serial: z.string().optional() }).safeParse(await response.json().catch(() => null))
        const remoteDeviceId = parsed.success ? device.platform === 'ios' ? parsed.data.device : parsed.data.serial : null
        if (!remoteDeviceId) throw new Error('The EAS preview returned no device id.')
        if (epoch !== this.epoch) break
        return { device: { ...device, deviceId: id, booted: true }, remoteDeviceId,
          preview: { origin, token: remote.webPreviewToken }, agent: { baseUrl: remote.agentDeviceRemoteSessionUrl.replace(/\/$/, ''), token: remote.agentDeviceRemoteSessionToken, deviceId: remoteDeviceId } }
      }
      await this.delay(5_000)
    }
    throw new Error('The EAS session did not become ready, or device support stopped.')
  }


  private async shutdown(id: string): Promise<void> {
    if (!terminal(await this.api.stop(id))) throw new Error('Expo has not confirmed that this session stopped. Try again.')
    this.sessions.delete(id)
    this.ledger = this.ledger.filter((entry) => entry.id !== id)
    await this.saveLedger()
  }

  async recover(): Promise<void> { await this.initialize() }

  async ensureReady(): Promise<DeviceHostReady> {
    if (this.ready) return this.ready
    if (!this.config.appId) throw new Error('Choose an Expo project in device settings.')
    await this.api.check(this.config.appId)
    await this.initialize()
    return this.ready ??= {
      hubOrigin: '', nodePath: '', helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: async () => ({ code: 127, stdout: '', stderr: 'EAS does not expose host commands.' }),
      devices: {
        list: () => this.list(),
        boot: (device) => {
          const start = this.boot(device)
          this.starts.add(start)
          void start.finally(() => this.starts.delete(start)).catch(() => {})
          return start
        },
        shutdown: (id) => this.shutdown(id),
        agentEndpoint: (id) => this.sessions.get(id)?.agent ?? null,
        screenshot: async (device) => {
          const upstream = this.upstream(device.deviceId, 'screenshot')
          if (!upstream) throw new Error('This EAS session ended.')
          const response = await this.fetchImpl(upstream.url, { method: 'POST', headers: upstream.headers, signal: AbortSignal.timeout(20_000) })
          if (!response.ok) throw new Error('The EAS screenshot failed.')
          return new Uint8Array(await response.arrayBuffer())
        },
      },
      upstream: (id, route) => this.upstream(id, route),
    }
  }

  private upstream(id: string, route: string) {
    const session = this.sessions.get(id)
    if (!session) return null
    const device = encodeURIComponent(session.remoteDeviceId)
    const prefix = session.device.platform === 'ios' ? '' : '/vendor/serve-emu'
    const routes = session.device.platform === 'ios'
      ? { 'video.avcc': `/helper/${device}/stream.avcc`, 'video.mjpeg': `/helper/${device}/stream.mjpeg`, socket: `/helper/ws?device=${device}`, offer: `/helper/${device}/webrtc/offer`, close: `/helper/${device}/webrtc/close`, screenshot: `/api/screenshot?device=${device}`, config: '/api' }
      : { socket: `/ws?device=${device}&frame-meta=1`, offer: `/webrtc/offer?device=${device}`, close: `/webrtc/close?device=${device}`, screenshot: `/api/screenshot?device=${device}`, config: '/api' }
    const path = Object.entries(routes).find(([key]) => key === route)?.[1]
    if (!path) return null
    const protocol = session.device.platform === 'ios' ? 'serve-sim' : 'serve-emu'
    return { url: `${session.preview.origin}${prefix}${path}`, headers: { authorization: `Bearer ${session.preview.token}` }, protocols: [`${protocol}.token.${session.preview.token}`] }
  }

  async ensureAgentReady() { return { ...await this.ensureReady(), agentDevice: null } }
  current() { return this.ready }
  async updateTool() { throw new Error('Expo manages the tools on EAS devices.') }
  async stopAgent() {}
  async stop() {
    this.epoch++
    await Promise.allSettled(this.starts)
    await Promise.all([...this.sessions.keys()].map((id) => this.shutdown(id)))
    await this.initialize()
    await this.reap()
    if (this.ledger.length) throw new Error('An EAS start has an unknown result. Keep this source configured and refresh it so Solus can find and stop the session.')
    this.ready = null
  }
}
