import { randomUUID } from 'node:crypto'
import {
  LOCAL_DEVICE_HOST_ID,
  type DeviceConfigureRequest,
  type DeviceControlHolder,
  type DeviceControlResult,
  type DeviceHostStatusEntry,
  type DeviceHostSummary,
  type DeviceOpenRequest,
  type DevicePlatform,
  type DevicePreview,
  type DeviceScreenshotResult,
  type DeviceSettingsState,
  type DeviceState,
  type DeviceSummary,
  type SshDeviceHostConfig,
  type DeviceBooting,
  type DeviceAction,
  type DeviceDetail,
  type DeviceInput,
  type DeviceBuild,
  deviceBuildFits,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { DeviceControl, type DeviceControlTarget } from './device-control'
import { DeviceDomainError, deviceErrorDetail } from './device-errors'
import type { AgentDeviceEndpoint, DeviceHost, DeviceHostAgentReady, DeviceHostReady } from './device-host'
import { DeviceHubClient, parseSimctlDevices, pngDimensions } from './device-hub-client'
import { discoverPhysicalDevices } from './device-physical'
import { installBuild, type DeviceBuildStore, type StoredDeviceBuild } from './device-builds'
import type { DeviceSettingsStore } from './device-settings-store'
import type { DeviceToolName } from './device-toolchain'
import { readDeviceDetail, runDeviceAction } from './device-actions'
import type { DeviceStreams } from './device-streams'

const log = createLogger('devices', 'device-manager.ts')

export interface DeviceReadiness extends DeviceHostReady {
  deviceHostId: string
}

export interface DeviceManagerDeps {
  settings: DeviceSettingsStore
  localHost: DeviceHost
  /** Builds the SSH device host for one configuration. */
  makeSshHost?: ((config: SshDeviceHostConfig) => DeviceHost) | undefined
  /** True when an SSH target resolves to this machine; it would duplicate `local`. */
  isLocalSshTarget?: ((config: SshDeviceHostConfig) => Promise<boolean>) | undefined
  hub?: DeviceHubClient
  /** Every state change. Receivers re-check admission before forwarding. */
  publish: (state: DeviceState) => void
  /** Ask clients showing `sessionId` to reveal a preview. */
  surfaceRequested: (payload: { sessionId: string; devicePreviewId: string; openedBy: 'user' | 'agent' }) => void
  storeImage: (bytes: Buffer) => Promise<{ assetId: string }>
  /** App builds agents hand over. Absent in tests that do not install. */
  builds?: DeviceBuildStore
  /** Live video and input links. Ended when their device goes away. */
  streams?: DeviceStreams
  /** Agent CLI bindings that must stop working: access off, preview closed, host changed. */
  revokeAgentBindings?: (predicate: (binding: { sessionId: string; deviceHostId: string; deviceId: string }) => boolean) => void
  now?: () => number
}

interface HostEntry {
  host: DeviceHost
  config?: SshDeviceHostConfig
}

function statusEntry(deviceHostId: string, status: DeviceHostStatusEntry['status'], detail: string | undefined): DeviceHostStatusEntry {
  const entry: DeviceHostStatusEntry = { deviceHostId, status }
  if (detail) entry.detail = detail
  return entry
}

/**
 * The one authoritative owner of native device state on a Solus host:
 * inventory, helper status, session previews, control leases and revision.
 * Process and stream handles stay in memory and are never restored as live
 * after a restart. Adapted in part from T3 Code (MIT, pingdotgg/t3code@43bd667,
 * apps/server/src/device/DeviceService.ts).
 */
export class DeviceManager {
  readonly control: DeviceControl
  private readonly hosts = new Map<string, HostEntry>()
  private readonly hub: DeviceHubClient
  private readonly now: () => number
  private revision = 0
  private hostSummaries = new Map<string, DeviceHostSummary>()
  /** Daemon endpoints of hosts whose agent tools are running. Never sent to clients. */
  private readonly agentEndpoints = new Map<string, AgentDeviceEndpoint>()
  private hostStatuses = new Map<string, DeviceHostStatusEntry>()
  private devices: DeviceSummary[] = []
  private previews: DevicePreview[] = []
  private booting: DeviceBooting[] = []
  /** Serializes enable/disable and host replacement against opens. */
  private lifecycle: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DeviceManagerDeps) {
    this.hub = deps.hub ?? new DeviceHubClient()
    this.now = deps.now ?? Date.now
    this.control = new DeviceControl(() => this.publish(), this.now)
    this.hosts.set(LOCAL_DEVICE_HOST_ID, { host: deps.localHost })
    if (!this.settings().enabled) this.hostStatuses.set(LOCAL_DEVICE_HOST_ID, { deviceHostId: LOCAL_DEVICE_HOST_ID, status: 'disabled' })
  }

  /** Read SSH host configuration from settings. Called once at boot. */
  async start(): Promise<void> {
    await this.reconcileSshHosts(this.settings().sshHosts)
    await this.refreshSummaries()
  }

  settings(): DeviceSettingsState {
    return this.deps.settings.get()
  }

  state(): DeviceState {
    const { sshHosts: _sshHosts, ...settings } = this.settings()
    return {
      revision: this.revision,
      settings,
      hosts: [...this.hosts.keys()].flatMap((id) => {
        const summary = this.hostSummaries.get(id)
        return summary ? [structuredClone(summary)] : []
      }),
      hostStatuses: [...this.hostStatuses.values()].map((entry) => ({ ...entry })),
      devices: this.devices.map((device) => ({ ...device })),
      previews: this.previews.map((preview) => ({ ...preview })),
      booting: this.booting.map((entry) => ({ ...entry })),
      controls: this.control.states(),
      builds: this.deps.builds?.list() ?? [],
    }
  }

  private publishQueued = false

  /** Changes in one tick publish one snapshot. The revision counts changes. */
  private publish(): void {
    this.revision++
    if (this.publishQueued) return
    this.publishQueued = true
    queueMicrotask(() => {
      this.publishQueued = false
      this.deps.publish(this.state())
    })
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(work, work)
    this.lifecycle = run.then(() => {}, () => {})
    return run
  }

  private entry(deviceHostId: string): HostEntry {
    const entry = this.hosts.get(deviceHostId)
    if (!entry) throw new DeviceDomainError('host_unavailable', `Device host ${deviceHostId} is not configured.`)
    return entry
  }

  private setHostStatus(deviceHostId: string, status: DeviceHostStatusEntry['status'], detail?: string): void {
    if (!this.hosts.has(deviceHostId)) return
    this.hostStatuses.set(deviceHostId, statusEntry(deviceHostId, status, detail))
    this.publish()
  }

  private requireEnabled(): void {
    if (!this.settings().enabled) {
      throw new DeviceDomainError('feature_disabled', 'Device support is off. Turn it on in Devices setup before installing or starting device tools.')
    }
  }

  private async refreshSummaries(): Promise<void> {
    for (const [id, entry] of this.hosts) {
      try {
        const summary = await entry.host.summary()
        if (this.hosts.get(id) === entry) this.hostSummaries.set(id, summary)
      } catch (error) {
        log.warn('device_host_summary_failed', { deviceHostId: id, error: deviceErrorDetail(error) })
      }
    }
    this.publish()
  }

  /** Start the hub on one host if setup allows it. Old host instances cannot publish. */
  async readiness(deviceHostId = LOCAL_DEVICE_HOST_ID): Promise<DeviceReadiness> {
    this.requireEnabled()
    const entry = this.entry(deviceHostId)
    let ready: DeviceHostReady
    try {
      ready = await entry.host.ensureReady((phase, detail) => {
        if (this.hosts.get(deviceHostId) === entry) this.setHostStatus(deviceHostId, phase, detail)
      })
    } catch (error) {
      const detail = deviceErrorDetail(error)
      if (this.hosts.get(deviceHostId) === entry) this.setHostStatus(deviceHostId, 'failed', detail)
      throw new DeviceDomainError('host_unavailable', detail, error)
    }
    if (this.hosts.get(deviceHostId) !== entry) {
      throw new DeviceDomainError('host_unavailable', 'The device host configuration changed. Retry the operation.')
    }
    if (!this.settings().enabled) throw new DeviceDomainError('feature_disabled', 'Device support was turned off.')
    if (this.hostStatuses.get(deviceHostId)?.status !== 'ready') this.setHostStatus(deviceHostId, 'ready')
    return { deviceHostId, ...ready }
  }

  /** Agent endpoints, only when device support and agent access are both on. */
  async agentReadiness(deviceHostId = LOCAL_DEVICE_HOST_ID): Promise<DeviceHostAgentReady & { deviceHostId: string }> {
    const settings = this.settings()
    this.requireEnabled()
    if (!settings.agentAccessEnabled) {
      throw new DeviceDomainError('feature_disabled', 'Agent device access is off. The user can turn it on in Devices setup.')
    }
    const entry = this.entry(deviceHostId)
    try {
      const ready = await entry.host.ensureAgentReady((phase, detail) => {
        if (this.hosts.get(deviceHostId) === entry) this.setHostStatus(deviceHostId, phase, detail)
      })
      if (this.hosts.get(deviceHostId) !== entry) throw new DeviceDomainError('host_unavailable', 'The device host configuration changed. Retry the operation.')
      if (!this.settings().agentAccessEnabled) throw new DeviceDomainError('feature_disabled', 'Agent device access was turned off.')
      this.agentEndpoints.set(deviceHostId, ready.agentDevice)
      this.setHostStatus(deviceHostId, 'ready')
      return { deviceHostId, ...ready }
    } catch (error) {
      if (error instanceof DeviceDomainError) throw error
      const detail = deviceErrorDetail(error)
      if (this.hosts.get(deviceHostId) === entry) this.setHostStatus(deviceHostId, 'failed', detail)
      throw new DeviceDomainError('host_unavailable', detail, error)
    }
  }

  /** The running daemon endpoint for a host, for the agent bridge only. */
  agentEndpoint(deviceHostId: string): AgentDeviceEndpoint | null {
    return this.settings().enabled && this.settings().agentAccessEnabled ? this.agentEndpoints.get(deviceHostId) ?? null : null
  }

  /** Current hub endpoints without starting anything. */
  currentReadiness(deviceHostId: string): DeviceReadiness | null {
    const ready = this.hosts.get(deviceHostId)?.host.current()
    return ready ? { deviceHostId, ...ready } : null
  }

  private async refreshHost(ready: DeviceReadiness): Promise<DeviceSummary[]> {
    const entry = this.hosts.get(ready.deviceHostId)
    const iosAvailable = !!entry && (await entry.host.platformAvailability('ios')).available
    const androidAvailable = !!entry && (await entry.host.platformAvailability('android')).available
    const unavailable: DevicePlatform[] = []
    if (!iosAvailable) unavailable.push('ios')
    if (!androidAvailable) unavailable.push('android')
    const { devices, detail } = await this.hub.listDevices(ready.hubOrigin, ready.deviceHostId, unavailable)
    // The hub lists only simulators that have booted before; a fresh install
    // would show none. Every available simulator is added, stopped.
    if (iosAvailable) {
      const listed = await ready.run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { timeoutMs: 15_000 })
      if (listed.code === 0) {
        for (const simulator of parseSimctlDevices(listed.stdout, ready.deviceHostId)) {
          if (!devices.some((device) => device.platform === 'ios' && device.deviceId === simulator.deviceId)) devices.push(simulator)
        }
      }
    }
    if (androidAvailable) {
      const avds = await ready.run('emulator', ['-list-avds'], { timeoutMs: 15_000 })
      if (avds.code === 0) {
        for (const name of avds.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 100)) {
          if (!devices.some((device) => device.platform === 'android' && device.name === name)) {
            devices.push({ deviceHostId: ready.deviceHostId, deviceId: name, name, platform: 'android', version: 'Android', booted: false, physical: false })
          }
        }
      }
    }
    // Connected phones replace any hub entry for them: only Solus reads why one cannot take an install.
    const physical = await discoverPhysicalDevices(ready.run, ready.deviceHostId, { ios: iosAvailable, android: androidAvailable })
    for (let index = devices.length - 1; index >= 0; index--) {
      if (devices[index]!.physical || physical.some((device) => device.deviceId === devices[index]!.deviceId)) devices.splice(index, 1)
    }
    devices.push(...physical)
    if (!this.settings().enabled || !entry || this.hosts.get(ready.deviceHostId) !== entry) return this.devices
    this.devices = [...this.devices.filter((device) => device.deviceHostId !== ready.deviceHostId), ...devices]
    this.hostStatuses.set(ready.deviceHostId, statusEntry(ready.deviceHostId, 'ready', detail))
    this.publish()
    return this.devices
  }

  /** Discover devices on every host. Starts helpers only once setup has enabled them. */
  async list(): Promise<DeviceState> {
    if (!this.settings().enabled) return this.state()
    await Promise.all([...this.hosts.keys()].map(async (deviceHostId) => {
      try {
        const entry = this.entry(deviceHostId)
        const summary = await entry.host.summary()
        if (this.hosts.get(deviceHostId) === entry) this.hostSummaries.set(deviceHostId, summary)
        if (summary.kind === 'local' && !summary.platforms.some((platform) => platform.available)) {
          this.setHostStatus(deviceHostId, 'idle', 'No simulator platform is available on this host.')
          return
        }
        await this.refreshHost(await this.readiness(deviceHostId))
      } catch (error) {
        this.setHostStatus(deviceHostId, 'failed', deviceErrorDetail(error))
      }
    }))
    return this.state()
  }

  /** Re-read tool versions and platforms. Never installs, boots or starts anything. */
  async inspect(): Promise<DeviceState> {
    await Promise.all([...this.hosts].map(async ([id, entry]) => {
      try {
        const summary = await entry.host.summary()
        if (this.hosts.get(id) === entry) this.hostSummaries.set(id, summary)
      } catch {
        const previous = this.hostSummaries.get(id)
        if (previous && this.hosts.get(id) === entry) {
          this.hostSummaries.set(id, { ...previous, toolInspectionError: 'Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.' })
        }
      }
    }))
    this.publish()
    return this.state()
  }

  async retryHost(deviceHostId: string): Promise<DeviceState> {
    this.entry(deviceHostId)
    if (!this.settings().enabled) return this.state()
    try {
      const ready = this.settings().agentAccessEnabled
        ? await this.agentReadiness(deviceHostId).catch(() => this.readiness(deviceHostId))
        : await this.readiness(deviceHostId)
      await this.refreshHost(ready)
    } catch (error) {
      this.setHostStatus(deviceHostId, 'failed', deviceErrorDetail(error))
    }
    return this.state()
  }

  async updateTool(deviceHostId: string, tool: DeviceToolName): Promise<DeviceState> {
    const entry = this.entry(deviceHostId)
    try {
      await entry.host.updateTool(tool)
    } catch (error) {
      throw new DeviceDomainError('command_failed', deviceErrorDetail(error), error)
    }
    return this.inspect()
  }

  async configure(request: DeviceConfigureRequest): Promise<DeviceState> {
    let agentTurnedOn = false
    await this.serially(async () => {
      const before = this.settings()
      const next = await this.deps.settings.update(settingsPatch(request))
      // Agents gain the bridge when access is chosen, or when device support
      // comes on with access already on (the default).
      agentTurnedOn = next.enabled && next.agentAccessEnabled
        && (request.agentAccessEnabled === true || (next.enabled && !before.enabled))
      if (!next.enabled && before.enabled) {
        // Turning the hub off stops owned helpers. Devices keep running.
        for (const { host } of this.hosts.values()) await host.stop().catch(() => {})
        this.agentEndpoints.clear()
        this.deps.revokeAgentBindings?.(() => true)
        this.deps.streams?.end(() => true, 'Device support was turned off.')
        this.control.forget(() => true)
        this.devices = []
        this.previews = []
        this.booting = []
      } else if (next.enabled && !next.agentAccessEnabled && before.agentAccessEnabled) {
        // Agents lose the bridge; manual viewing stays.
        this.agentEndpoints.clear()
        this.deps.revokeAgentBindings?.(() => true)
        for (const { host } of this.hosts.values()) await host.stopAgent().catch(() => {})
      }
      this.hostStatuses.clear()
      if (!next.enabled) for (const id of this.hosts.keys()) this.hostStatuses.set(id, { deviceHostId: id, status: 'disabled' })
      this.publish()
    })
    if (agentTurnedOn && this.settings().enabled && this.settings().agentAccessEnabled) {
      await this.agentReadiness().catch((error) => log.warn('device_agent_start_failed', { error: deviceErrorDetail(error) }))
    }
    return this.settings().enabled ? this.list() : this.state()
  }

  // ─── SSH hosts ───

  /** Save the whole SSH host list. Changed hosts are rebuilt; their old previews and tunnels end. */
  async saveSshHosts(hosts: SshDeviceHostConfig[]): Promise<DeviceState> {
    await this.serially(async () => {
      await this.deps.settings.update({ sshHosts: hosts })
      await this.reconcileSshHosts(hosts)
    })
    await this.refreshSummaries()
    return this.state()
  }

  private async reconcileSshHosts(configs: SshDeviceHostConfig[]): Promise<void> {
    const wanted = new Map<string, SshDeviceHostConfig>()
    for (const config of configs) {
      if (this.deps.isLocalSshTarget && (await this.deps.isLocalSshTarget(config).catch(() => false))) {
        log.info('device_ssh_host_is_local', { deviceHostId: config.id })
        continue
      }
      wanted.set(config.id, config)
    }
    for (const [id, entry] of this.hosts) {
      if (id === LOCAL_DEVICE_HOST_ID) continue
      const config = wanted.get(id)
      if (config && entry.config && JSON.stringify(config) === JSON.stringify(entry.config)) continue
      this.removeHost(id, entry)
      await entry.host.stop().catch((error) => log.warn('device_ssh_host_stop_failed', { deviceHostId: id, error: deviceErrorDetail(error) }))
    }
    if (!this.deps.makeSshHost) return
    for (const [id, config] of wanted) {
      if (this.hosts.has(id)) continue
      this.hosts.set(id, { host: this.deps.makeSshHost(config), config })
      this.hostStatuses.set(id, { deviceHostId: id, status: this.settings().enabled ? 'idle' : 'disabled' })
    }
    this.publish()
  }

  private removeHost(deviceHostId: string, entry: HostEntry): void {
    if (this.hosts.get(deviceHostId) !== entry) return
    this.hosts.delete(deviceHostId)
    this.hostSummaries.delete(deviceHostId)
    this.hostStatuses.delete(deviceHostId)
    this.devices = this.devices.filter((device) => device.deviceHostId !== deviceHostId)
    this.previews = this.previews.filter((preview) => preview.deviceHostId !== deviceHostId)
    this.booting = this.booting.filter((entry) => entry.deviceHostId !== deviceHostId)
    this.agentEndpoints.delete(deviceHostId)
    this.deps.revokeAgentBindings?.((binding) => binding.deviceHostId === deviceHostId)
    this.deps.streams?.end((target) => target.deviceHostId === deviceHostId, 'The device host was removed.')
    this.control.forget((target) => target.deviceHostId === deviceHostId)
  }

  // ─── Devices ───

  findDevice(deviceHostId: string, deviceId: string): DeviceSummary | undefined {
    return this.devices.find((device) => device.deviceHostId === deviceHostId && device.deviceId === deviceId)
  }

  /** The device, refreshing inventory once when it is not known yet. */
  async resolveDevice(deviceHostId: string, deviceId: string): Promise<{ ready: DeviceReadiness; device: DeviceSummary }> {
    const ready = await this.readiness(deviceHostId)
    const device = this.findDevice(deviceHostId, deviceId)
      ?? (await this.refreshHost(ready)).find((candidate) => candidate.deviceHostId === deviceHostId && candidate.deviceId === deviceId)
    if (!device) throw new DeviceDomainError('device_not_found', `Device ${deviceId} was not found on host ${deviceHostId}.`)
    return { ready, device }
  }

  async open(request: DeviceOpenRequest & { deviceHostId: string }, openedBy: 'user' | 'agent'): Promise<DevicePreview> {
    const entry = this.entry(request.deviceHostId)
    const availability = await entry.host.platformAvailability(request.platform)
    if (!availability.available) {
      throw new DeviceDomainError('platform_unavailable', availability.reason ?? `${request.platform} devices are unavailable on this host.`)
    }
    const ready = await this.readiness(request.deviceHostId)
    await this.refreshHost(ready)
    let device = this.findDevice(request.deviceHostId, request.deviceId)
    if (!device) throw new DeviceDomainError('device_not_found', `Device ${request.deviceId} was not found on host ${request.deviceHostId}.`)
    if (device.physical) {
      throw new DeviceDomainError('action_unsupported', `${device.name} is a connected device. Solus can install builds on it but cannot show its screen.`)
    }
    if (!device.booted && request.boot !== false) {
      const booting: DeviceBooting = { deviceHostId: device.deviceHostId, deviceId: device.deviceId, sessionId: request.sessionId }
      this.booting = [...this.booting.filter((item) => item.deviceHostId !== booting.deviceHostId || item.deviceId !== booting.deviceId), booting]
      this.publish()
      let result: Awaited<ReturnType<DeviceHubClient['boot']>>
      try {
        result = await this.hub.boot(ready.hubOrigin, device)
      } finally {
        this.booting = this.booting.filter((item) => item !== booting)
        this.publish()
      }
      if (!result.ok) {
        const explanation = {
          disk_space: 'There is not enough free disk space on the device host.',
          timeout: 'The device did not become ready in time. Try again.',
          launch_failed: 'The simulator or emulator could not start. Check its configuration on the device host.',
        }[result.reason]
        throw new DeviceDomainError('boot_failed', `${device.name} failed to boot: ${explanation}`)
      }
      await this.refreshHost(ready)
      // An AVD name becomes an emulator serial; reconcile without a duplicate preview.
      device = this.findDevice(request.deviceHostId, result.deviceId)
        ?? this.devices.find((candidate) => candidate.deviceHostId === request.deviceHostId && candidate.platform === 'android' && candidate.name === device!.name && candidate.booted)
        ?? device
    } else if (device.platform === 'ios' && device.booted) {
      // A simulator booted outside Solus has no capture helper attached yet.
      await this.hub.attachIos(ready.hubOrigin, device.deviceId)
    }
    if (this.hosts.get(request.deviceHostId) !== entry) {
      throw new DeviceDomainError('host_unavailable', 'The device host configuration changed. Retry the operation.')
    }
    return this.serially(async () => {
      if (!this.settings().enabled) throw new DeviceDomainError('feature_disabled', 'Device support was turned off while the device was opening.')
      const opened = device!
      const existing = this.previews.find((preview) => preview.sessionId === request.sessionId
        && preview.deviceHostId === opened.deviceHostId
        && (preview.deviceId === opened.deviceId || preview.deviceId === request.deviceId))
      const preview: DevicePreview = existing
        ? { ...existing, deviceId: opened.deviceId }
        : {
          devicePreviewId: `devp_${randomUUID()}`,
          sessionId: request.sessionId,
          deviceHostId: opened.deviceHostId,
          deviceId: opened.deviceId,
          platform: opened.platform,
          openedAt: this.now(),
          openedBy,
        }
      this.previews = [...this.previews.filter((item) => item !== existing), preview]
      this.publish()
      this.deps.surfaceRequested({ sessionId: preview.sessionId, devicePreviewId: preview.devicePreviewId, openedBy })
      return preview
    })
  }

  previewsForSession(sessionId: string): DevicePreview[] {
    return this.previews.filter((preview) => preview.sessionId === sessionId).map((preview) => ({ ...preview }))
  }

  /** Remove previews from a session. The device keeps running. */
  close(request: { sessionId: string; deviceHostId?: string | undefined; deviceId?: string | undefined }): DevicePreview[] {
    const closing = this.previews.filter((preview) => preview.sessionId === request.sessionId
      && (request.deviceHostId === undefined || preview.deviceHostId === request.deviceHostId)
      && (request.deviceId === undefined || preview.deviceId === request.deviceId))
    if (closing.length === 0) return []
    this.previews = this.previews.filter((preview) => !closing.includes(preview))
    for (const preview of closing) {
      this.control.dropAgent(request.sessionId, preview)
      this.deps.revokeAgentBindings?.((binding) => binding.sessionId === request.sessionId
        && binding.deviceHostId === preview.deviceHostId && binding.deviceId === preview.deviceId)
    }
    this.publish()
    return closing
  }

  /** Power a device off. Every session's preview of it ends. */
  async shutdown(target: { deviceHostId: string; deviceId: string; platform: DevicePlatform }): Promise<void> {
    const ready = await this.readiness(target.deviceHostId)
    let accepted = false
    try {
      accepted = await this.hub.shutdown(ready.hubOrigin, target.platform, target.deviceId)
    } catch (error) {
      // serve-sim fails on a simulator that is already off; accept that only
      // when discovery confirms it.
      const devices = await this.refreshHost(ready).catch(() => this.devices)
      const known = devices.find((device) => device.deviceHostId === target.deviceHostId && device.deviceId === target.deviceId)
      if (known?.booted !== false) throw error
      accepted = true
    }
    if (!accepted) throw new DeviceDomainError('command_failed', 'The device host refused to shut the device down.')
    const sameDevice = (item: { deviceHostId: string; deviceId: string }) => item.deviceHostId === target.deviceHostId && item.deviceId === target.deviceId
    this.devices = this.devices.map((device) => (sameDevice(device) ? { ...device, booted: false } : device))
    this.previews = this.previews.filter((preview) => !sameDevice(preview))
    this.deps.streams?.end(sameDevice, 'The device was shut down.')
    this.deps.revokeAgentBindings?.(sameDevice)
    this.control.forget(sameDevice)
    this.publish()
    await this.refreshHost(ready).catch((error) => log.warn('device_refresh_after_shutdown_failed', { error: deviceErrorDetail(error) }))
  }

  async screenshot(deviceHostId: string, deviceId: string): Promise<DeviceScreenshotResult & { png: Uint8Array }> {
    const { ready, device } = await this.resolveDevice(deviceHostId, deviceId)
    const png = await this.hub.screenshot(ready.hubOrigin, device.platform, device.deviceId)
    const { assetId } = await this.deps.storeImage(Buffer.from(png))
    return { device: { ...device }, assetId, ...pngDimensions(png), capturedAt: this.now(), png }
  }

  async detail(target: DeviceControlTarget): Promise<DeviceDetail> {
    const { ready, device } = await this.resolveDevice(target.deviceHostId, target.deviceId)
    const read = await readDeviceDetail(ready, device.platform, device.deviceId)
    return { deviceHostId: device.deviceHostId, deviceId: device.deviceId, ...read, readAt: this.now() }
  }

  /** Run one Tools action under the caller's control lease, then read the device back. */
  async action(target: DeviceControlTarget, action: DeviceAction, controlGeneration: number, holder: DeviceControlHolder): Promise<DeviceDetail> {
    const end = this.control.begin(target, controlGeneration, holder)
    try {
      const { ready, device } = await this.resolveDevice(target.deviceHostId, target.deviceId)
      await runDeviceAction(ready, device.platform, device.deviceId, action)
    } finally {
      end()
    }
    return this.detail(target)
  }

  // ─── Builds ───

  /** Record an agent's build output so people and agents can install it. */
  async addBuild(path: string, sessionId: string, appId?: string): Promise<StoredDeviceBuild> {
    const build = await this.requireBuilds().add(path, sessionId, appId)
    this.publish()
    return build
  }

  /** Install a build under the caller's control lease, then open it. */
  async installBuild(target: DeviceControlTarget, buildId: string, controlGeneration: number, holder: DeviceControlHolder, launch = true): Promise<{ build: DeviceBuild; device: DeviceSummary; launched: boolean }> {
    const builds = this.requireBuilds()
    const end = this.control.begin(target, controlGeneration, holder)
    try {
      const build = builds.get(buildId)
      const { ready, device } = await this.resolveDevice(target.deviceHostId, target.deviceId)
      const fit = deviceBuildFits(build, device)
      if (!fit.fits) throw new DeviceDomainError('action_unsupported', fit.reason)
      const { launched } = await installBuild(ready.run, build, device, launch)
      const updated = await builds.noteInstall(buildId, device)
      log.info('device_build_installed', { buildId, deviceHostId: device.deviceHostId, deviceId: device.deviceId, physical: device.physical, launched })
      this.publish()
      return { build: updated, device: { ...device }, launched }
    } finally {
      end()
    }
  }

  private requireBuilds(): DeviceBuildStore {
    if (!this.deps.builds) throw new DeviceDomainError('request_failed', 'App builds are not available on this host.')
    return this.deps.builds
  }

  /** Watch a device. The subscription belongs to one authenticated client. */
  async subscribeFrames(clientId: string, target: DeviceControlTarget, format: 'h264' | 'jpeg'): Promise<void> {
    const streams = this.requireStreams()
    const { ready, device } = await this.resolveDevice(target.deviceHostId, target.deviceId)
    streams.subscribe(clientId, { deviceHostId: device.deviceHostId, deviceId: device.deviceId, platform: device.platform, hubOrigin: ready.hubOrigin }, format)
  }

  unsubscribeFrames(clientId: string, target: DeviceControlTarget): void {
    this.deps.streams?.unsubscribe(clientId, target)
  }

  /** Forward manual input under the caller's control lease. */
  async input(clientId: string, holder: DeviceControlHolder, request: { deviceHostId: string; deviceId: string; controlGeneration: number; screenGeneration: number; inputs: DeviceInput[] }): Promise<void> {
    const streams = this.requireStreams()
    const target = { deviceHostId: request.deviceHostId, deviceId: request.deviceId }
    const end = this.control.begin(target, request.controlGeneration, holder)
    try {
      const { ready, device } = await this.resolveDevice(target.deviceHostId, target.deviceId)
      await streams.input(clientId, { ...target, platform: device.platform, hubOrigin: ready.hubOrigin }, request.inputs, request.screenGeneration)
    } finally {
      end()
    }
  }

  private requireStreams(): DeviceStreams {
    if (!this.deps.streams) throw new DeviceDomainError('request_failed', 'Device streaming is not available on this host.')
    return this.deps.streams
  }

  // ─── Control ───

  async acquireControl(target: DeviceControlTarget, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceControlResult> {
    this.requireEnabled()
    this.entry(target.deviceHostId)
    return this.control.acquireForUser(target, holder)
  }

  releaseControl(target: DeviceControlTarget, holder: DeviceControlHolder): void {
    this.control.release(target, holder)
    if (holder.kind === 'user') void this.deps.streams?.get(target)?.cancelInput(holder.clientId)
  }

  /** A client disconnected: release any touch it holds. Its watches wait for expiry. */
  async cancelInput(clientId: string): Promise<void> {
    await this.deps.streams?.cancelInput(clientId)
  }

  /** A client expired: its watches, held input and control end. */
  async dropClient(clientId: string): Promise<void> {
    await this.deps.streams?.dropClient(clientId)
    this.control.dropClient(clientId)
  }

  /** Remove everything a host restart or process exit would invalidate. */
  async dispose(): Promise<void> {
    this.deps.streams?.closeAll()
    this.deps.revokeAgentBindings?.(() => true)
    for (const { host } of this.hosts.values()) await host.stop().catch(() => {})
  }
}

/** The settings a configure request names; an absent field keeps its value. */
function settingsPatch(request: DeviceConfigureRequest): Partial<DeviceSettingsState> {
  const patch: Partial<DeviceSettingsState> = {}
  if (request.enabled !== undefined) patch.enabled = request.enabled
  if (request.agentAccessEnabled !== undefined) patch.agentAccessEnabled = request.agentAccessEnabled
  if (request.onboardingCompleted !== undefined) patch.onboardingCompleted = request.onboardingCompleted
  if (request.autoShowAgentDevices !== undefined) patch.autoShowAgentDevices = request.autoShowAgentDevices
  return patch
}
