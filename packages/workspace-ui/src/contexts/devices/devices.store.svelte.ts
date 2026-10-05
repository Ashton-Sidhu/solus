import { SvelteMap } from 'svelte/reactivity'
import type {
  DeviceAction,
  DeviceBuild,
  DeviceProjectInfo,
  DeviceConfigureRequest,
  DeviceControlResult,
  DeviceControlState,
  DeviceDetail,
  DeviceHostTestResult,
  DeviceInput,
  DevicePlatform,
  DevicePreview,
  DeviceScreenshotResult,
  DeviceState,
  DeviceSummary,
  SshDeviceHostConfig,
} from '@solus/contracts/device-types'
import { parseDeviceError } from '@solus/contracts/device-types'
import type { DeviceFrameListener } from '@solus/client-core/device-frame-subscriber'
import type { DeviceFrameHeader } from '@solus/contracts/device-types'
import { buildDownloadName, installDeviceBuild } from '@solus/client-core/device-builds'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The renderer's mirror of each host's device manager
 * (docs/plans/native-devices.md). The host owns inventory, previews and
 * control; this store adds what one client needs: the latest snapshot per
 * host behind a revision guard, the control lease this client holds, and one
 * host-side frame subscription per visible device.
 */

export interface DeviceTargetRef {
  deviceHostId: string
  deviceId: string
}

interface FrameWatch {
  serverId: string
  target: DeviceTargetRef
  format: 'h264' | 'jpeg'
  listeners: number
  /** The host sends the screen and its input generation once per subscription.
   *  A surface that joins the watch later gets this copy, or its taps would
   *  name a screen the host already replaced. */
  lastScreen: DeviceFrameHeader | null
}

const deviceKey = (serverId: string, target: DeviceTargetRef) => `${serverId}\u0000${target.deviceHostId}\u0000${target.deviceId}`

/** A host error as one readable sentence, without the wire prefix. */
export function deviceErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const parsed = parseDeviceError(message)
  if (parsed) return parsed.message
  if (/not (registered|found|a function)|unknown method|deviceState/i.test(message)) {
    return 'This host does not support device previews. Update Solus on it.'
  }
  return message
}

export class DevicesStore {
  /** The latest snapshot per host. Replaced only by a newer revision or a fresh load. */
  states = new SvelteMap<string, DeviceState>()
  /** Why a host's devices cannot be shown, when they cannot. */
  unavailable = new SvelteMap<string, string>()
  /** The lease generation this client was granted, per device. */
  private grants = new SvelteMap<string, number>()
  details = new SvelteMap<string, DeviceDetail>()
  /** Which projects build a mobile app, per host and project root. */
  private projects = new SvelteMap<string, DeviceProjectInfo>()
  private projectReads = new Set<string>()
  private loadVersions = new Map<string, number>()
  private frameWatches = new Map<string, FrameWatch>()

  /** Set by the shell: a session's device asked to be shown. */
  onSurfaceRequested: ((serverId: string, payload: { sessionId: string; devicePreviewId: string; openedBy: 'user' | 'agent' }) => void) | null = null

  subscribe(): () => void {
    const unsubscribers = [
      subscribeAllHosts('device.stateChanged', (serverId, { state }) => this.adopt(serverId, state, false)),
      subscribeAllHosts('device.surfaceRequested', (serverId, payload) => this.onSurfaceRequested?.(serverId, payload)),
      serverConnections.onStatusChange((serverId, status) => {
        if (status !== 'connected') return
        void this.load(serverId)
        this.restoreFrames(serverId)
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }

  /**
   * Adopt a snapshot. Events older than what is shown are ignored; a fresh
   * load is authoritative, because a restarted host counts revisions from zero.
   */
  private adopt(serverId: string, state: DeviceState, authoritative: boolean): void {
    const current = this.states.get(serverId)
    if (!authoritative && current && state.revision <= current.revision) return
    this.states.set(serverId, state)
    this.unavailable.delete(serverId)
    // A grant whose lease is gone is not control any more.
    for (const [key, generation] of this.grants) {
      if (!key.startsWith(`${serverId}\u0000`)) continue
      const [, deviceHostId, deviceId] = key.split('\u0000')
      const control = state.controls.find((entry) => entry.deviceHostId === deviceHostId && entry.deviceId === deviceId)
      if (control?.lease?.generation !== generation) this.grants.delete(key)
    }
  }

  async load(serverId: string): Promise<void> {
    const version = (this.loadVersions.get(serverId) ?? 0) + 1
    this.loadVersions.set(serverId, version)
    try {
      const state = await serverConnections.apiFor(serverId).deviceState()
      if (this.loadVersions.get(serverId) !== version) return
      this.adopt(serverId, state, true)
    } catch (cause) {
      if (this.loadVersions.get(serverId) !== version) return
      this.unavailable.set(serverId, deviceErrorMessage(cause))
    }
  }

  /** Discover devices on the host. Starts helpers only once setup enabled them. */
  async refresh(serverId: string): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceList(), true)
  }

  async inspect(serverId: string): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceToolInspect(), true)
  }

  state(serverId: string): DeviceState | undefined {
    return this.states.get(serverId)
  }

  devices(serverId: string): DeviceSummary[] {
    return this.states.get(serverId)?.devices ?? []
  }

  previewsFor(serverId: string, sessionId: string | null | undefined): DevicePreview[] {
    if (!sessionId) return []
    return (this.states.get(serverId)?.previews ?? []).filter((preview) => preview.sessionId === sessionId)
  }

  /** Other sessions showing the same device: shown as concurrent use. */
  otherSessionsUsing(serverId: string, sessionId: string, target: DeviceTargetRef): number {
    return (this.states.get(serverId)?.previews ?? []).filter((preview) => preview.sessionId !== sessionId
      && preview.deviceHostId === target.deviceHostId && preview.deviceId === target.deviceId).length
  }

  device(serverId: string, target: DeviceTargetRef): DeviceSummary | undefined {
    return this.devices(serverId).find((device) => device.deviceHostId === target.deviceHostId && device.deviceId === target.deviceId)
  }

  isBooting(serverId: string, target: DeviceTargetRef): boolean {
    return (this.states.get(serverId)?.booting ?? []).some((entry) => entry.deviceHostId === target.deviceHostId && entry.deviceId === target.deviceId)
  }

  control(serverId: string, target: DeviceTargetRef): DeviceControlState {
    return this.states.get(serverId)?.controls.find((entry) => entry.deviceHostId === target.deviceHostId && entry.deviceId === target.deviceId)
      ?? { ...target, lease: null, agentPaused: false }
  }

  /** This client's live lease generation for a device, or null. */
  grant(serverId: string, target: DeviceTargetRef): number | null {
    const generation = this.grants.get(deviceKey(serverId, target))
    if (generation === undefined) return null
    return this.control(serverId, target).lease?.generation === generation ? generation : null
  }

  // ─── Setup ───

  async configure(serverId: string, request: DeviceConfigureRequest): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceConfigure(request), true)
  }

  async saveHost(serverId: string, config: SshDeviceHostConfig): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceHostSave(config), true)
  }

  async removeHost(serverId: string, deviceHostId: string): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceHostRemove(deviceHostId), true)
  }

  testHost(serverId: string, config: SshDeviceHostConfig): Promise<DeviceHostTestResult> {
    return serverConnections.apiFor(serverId).deviceHostTest(config)
  }

  async updateTool(serverId: string, deviceHostId: string, tool: 'hub' | 'agent'): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceToolUpdate({ deviceHostId, tool }), true)
  }

  async retryHost(serverId: string, deviceHostId: string): Promise<void> {
    this.adopt(serverId, await serverConnections.apiFor(serverId).deviceHostRetry(deviceHostId), true)
  }

  // ─── Previews ───

  open(serverId: string, sessionId: string, device: { deviceHostId: string; deviceId: string; platform: DevicePlatform }): Promise<DevicePreview> {
    return serverConnections.apiFor(serverId).deviceOpen({ sessionId, ...device })
  }

  close(serverId: string, sessionId: string, target: DeviceTargetRef): Promise<void> {
    return serverConnections.apiFor(serverId).deviceClose({ sessionId, ...target })
  }

  /** Power off. Needs control; takes it first when nobody else holds it. */
  async shutdown(serverId: string, target: DeviceTargetRef & { platform: DevicePlatform }): Promise<void> {
    const generation = await this.ensureControl(serverId, target)
    await serverConnections.apiFor(serverId).deviceShutdown({ ...target, controlGeneration: generation })
  }

  async screenshot(serverId: string, target: DeviceTargetRef): Promise<DeviceScreenshotResult> {
    return serverConnections.apiFor(serverId).deviceScreenshot(target)
  }

  // ─── Control ───

  async takeControl(serverId: string, target: DeviceTargetRef, sessionId?: string): Promise<DeviceControlResult> {
    const result = await serverConnections.apiFor(serverId).deviceControlAcquire({ ...target, sessionId })
    if (result.status === 'granted') this.grants.set(deviceKey(serverId, target), result.lease.generation)
    return result
  }

  /** The lease generation to act under. Takes control only when nobody holds it. */
  async ensureControl(serverId: string, target: DeviceTargetRef): Promise<number> {
    const held = this.grant(serverId, target)
    if (held !== null) return held
    const current = this.control(serverId, target)
    if (current.lease && current.lease.holder.kind === 'agent' && !current.agentPaused) {
      throw new Error(`${current.lease.holder.label} is controlling this device. Take control first.`)
    }
    const result = await this.takeControl(serverId, target)
    if (result.status !== 'granted') throw new Error('Someone else took control of this device.')
    return result.lease.generation
  }

  async releaseControl(serverId: string, target: DeviceTargetRef): Promise<void> {
    this.grants.delete(deviceKey(serverId, target))
    await serverConnections.apiFor(serverId).deviceControlRelease(target)
  }

  async resumeAgent(serverId: string, target: DeviceTargetRef): Promise<void> {
    this.grants.delete(deviceKey(serverId, target))
    await serverConnections.apiFor(serverId).deviceControlResume(target)
  }

  /** Send manual input under this client's lease. */
  async input(serverId: string, target: DeviceTargetRef, screenGeneration: number, inputs: DeviceInput[]): Promise<void> {
    const controlGeneration = await this.ensureControl(serverId, target)
    await serverConnections.apiFor(serverId).deviceInput({ ...target, controlGeneration, screenGeneration, inputs })
  }

  async action(serverId: string, target: DeviceTargetRef, action: DeviceAction): Promise<DeviceDetail> {
    const controlGeneration = await this.ensureControl(serverId, target)
    const detail = await serverConnections.apiFor(serverId).deviceAction({ ...target, controlGeneration, action })
    this.details.set(deviceKey(serverId, target), detail)
    return detail
  }

  /** Read settings back. A reply for a device no longer selected is still cached under its own key. */
  async loadDetail(serverId: string, target: DeviceTargetRef): Promise<DeviceDetail> {
    const detail = await serverConnections.apiFor(serverId).deviceDetail(target)
    this.details.set(deviceKey(serverId, target), detail)
    return detail
  }

  detail(serverId: string, target: DeviceTargetRef): DeviceDetail | undefined {
    return this.details.get(deviceKey(serverId, target))
  }

  // ─── Projects ───

  /** Whether the project builds a mobile app; undefined until the host answers. Asks once per root. */
  project(serverId: string, projectRoot: string): DeviceProjectInfo | undefined {
    const key = `${serverId}\u0000${projectRoot}`
    const known = this.projects.get(key)
    if (!known && !this.projectReads.has(key)) {
      this.projectReads.add(key)
      // An older host without the method has no device builds either.
      void serverConnections.apiFor(serverId).deviceProjectDetect(projectRoot).then(
        (info) => this.projects.set(key, info),
        () => this.projects.set(key, { isMobileApp: false, platforms: [], markers: [] }),
      )
    }
    return known
  }

  // ─── Builds ───

  /** Install a build and open it. Uses this client's lease, or borrows a free device. */
  async installBuild(serverId: string, target: DeviceTargetRef, build: DeviceBuild): Promise<void> {
    await installDeviceBuild(serverConnections.apiFor(serverId), target, build, this.control(serverId, target), this.grant(serverId, target))
  }

  /** A short-lived link that downloads an APK build, for a phone's browser. */
  async buildDownloadUrl(serverId: string, build: DeviceBuild): Promise<string> {
    if (!build.assetId) throw new Error('Only Android builds can be downloaded.')
    const signed = await serverConnections.apiFor(serverId).assetCreateUrl(undefined, { assetId: build.assetId, name: buildDownloadName(build) })
    return new URL(signed.relativeUrl, serverConnections.httpOriginFor(serverId)).toString()
  }

  // ─── Frames ───

  /**
   * Watch a device's video while a surface is visible. One host-side
   * subscription per device on this client, however many surfaces show it.
   */
  watchFrames(serverId: string, target: DeviceTargetRef, format: 'h264' | 'jpeg', listener: DeviceFrameListener, onError: (message: string) => void): () => void {
    const key = deviceKey(serverId, target)
    let watch = this.frameWatches.get(key)
    const isJoining = !!watch && watch.format === format
    if (!watch || watch.format !== format) {
      watch = { serverId, target, format, listeners: 0, lastScreen: null }
      this.frameWatches.set(key, watch)
    }
    const current = watch
    const unsubscribe = serverConnections.deviceFramesFor(serverId).subscribe(target.deviceHostId, target.deviceId, (header, data) => {
      if (header.kind === 'screen') current.lastScreen = header
      listener(header, data)
    })
    if (isJoining) {
      if (current.lastScreen) listener(current.lastScreen, new Uint8Array())
    } else {
      serverConnections.apiFor(serverId).deviceSubscribeFrames({ ...target, format })
        .catch((cause: unknown) => onError(deviceErrorMessage(cause)))
    }
    current.listeners++
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      current.listeners--
      if (current.listeners > 0 || this.frameWatches.get(key) !== current) return
      this.frameWatches.delete(key)
      void serverConnections.apiFor(serverId).deviceUnsubscribeFrames(target).catch(() => {})
    }
  }

  private restoreFrames(serverId: string): void {
    for (const watch of this.frameWatches.values()) {
      if (watch.serverId !== serverId) continue
      void serverConnections.apiFor(serverId).deviceSubscribeFrames({ ...watch.target, format: watch.format }).catch(() => {})
    }
  }
}

export const devicesStore = new DevicesStore()

