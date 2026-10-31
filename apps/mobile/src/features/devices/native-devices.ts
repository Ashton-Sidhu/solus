import type { HostApi } from '@solus/client-core/host-api'
import type { DeviceState, DeviceHostConfig, DeviceConfigureRequest, DeviceTarget, DeviceSummary } from '@solus/contracts/device-types'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'

export class NativeDevices {
  readonly changes = new Listeners()
  private readonly states = new Map<string, DeviceState>()
  private readonly grants = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void; epoch: number }>()
  constructor(private readonly connectionFor: (hostId: string) => HostConnection | null) {}
  stateOf = (hostId: string) => this.states.get(hostId)
  errorOf = (hostId: string) => this.errors.get(hostId)

  private connection(hostId: string) {
    const connection = this.connectionFor(hostId)
    if (!connection) throw new Error('This host is not connected.')
    if (this.watches.get(hostId)?.connection !== connection) {
      this.forgetHost(hostId)
      const watch = { connection, stop: () => {}, epoch: 0 }
      const stopEvent = connection.events.subscribe('device.stateChanged', ({ state }) => this.adopt(hostId, state))
      const stopReset = connection.onReset(() => { watch.epoch++; this.states.delete(hostId); this.changes.notify() })
      const stopAccepted = connection.onAccepted(() => { void this.load(hostId) })
      watch.stop = () => { stopEvent(); stopReset(); stopAccepted() }
      this.watches.set(hostId, watch)
    }
    return connection
  }
  private adopt(hostId: string, state: DeviceState) {
    if (state.revision < (this.states.get(hostId)?.revision ?? -1)) return
    this.states.set(hostId, state); this.errors.delete(hostId); this.changes.notify()
  }
  async load(hostId: string, discover = false) {
    try { await this.change(hostId, (api) => discover ? api.deviceList() : api.deviceState()) }
    catch (error) { this.errors.set(hostId, error instanceof Error ? error.message : String(error)); this.changes.notify() }
  }
  async change(hostId: string, command: (api: HostApi) => Promise<DeviceState>) {
    const connection = this.connection(hostId)
    const epoch = this.watches.get(hostId)!.epoch
    const state = await command(connection.api)
    if (this.connectionFor(hostId) === connection && this.watches.get(hostId)?.epoch === epoch) this.adopt(hostId, state)
  }
  configure(hostId: string, request: DeviceConfigureRequest) { return this.change(hostId, (api) => api.deviceConfigure(request)) }
  save(hostId: string, config: DeviceHostConfig) { return this.change(hostId, (api) => api.deviceHostSave(config)) }
  remove(hostId: string, id: string) { return this.change(hostId, (api) => api.deviceHostRemove(id)) }
  test(hostId: string, config: DeviceHostConfig) { return this.connection(hostId).api.deviceHostTest(config) }
  async open(hostId: string, sessionId: string, device: DeviceSummary) {
    const preview = await this.connection(hostId).api.deviceOpen({ sessionId, deviceHostId: device.deviceHostId, deviceId: device.deviceId, platform: device.platform })
    await this.load(hostId)
    return preview
  }
  async close(hostId: string, sessionId: string, target: DeviceTarget) {
    await this.connection(hostId).api.deviceClose({ sessionId, ...target }); await this.load(hostId)
  }
  async takeControl(hostId: string, target: DeviceTarget, sessionId?: string) {
    const result = await this.connection(hostId).api.deviceControlAcquire({ ...target, sessionId })
    this.grants.set(`${hostId}/${target.deviceHostId}/${target.deviceId}`, result.lease.generation)
    await this.load(hostId)
  }
  holdsControl(hostId: string, target: DeviceTarget): boolean {
    const lease = this.states.get(hostId)?.controls.find((control) => control.deviceHostId === target.deviceHostId && control.deviceId === target.deviceId)?.lease
    return !!lease && lease.holder.kind === 'user' && lease.generation === this.grants.get(`${hostId}/${target.deviceHostId}/${target.deviceId}`) && lease.expiresAt > Date.now()
  }
  async release(hostId: string, target: DeviceTarget) {
    this.grants.delete(`${hostId}/${target.deviceHostId}/${target.deviceId}`)
    await this.connection(hostId).api.deviceControlRelease(target); await this.load(hostId)
  }
  async resume(hostId: string, target: DeviceTarget) {
    await this.connection(hostId).api.deviceControlResume(target); await this.load(hostId)
  }
  async streamUrl(hostId: string, target: DeviceTarget) {
    const connection = this.connection(hostId)
    const stream = await connection.api.deviceStreamUrl(target)
    return new URL(stream.path, connection.transport.serverUrl.replace(/^ws/, 'http')).toString()
  }
  async screenshotUrl(hostId: string, target: DeviceTarget): Promise<string> {
    const connection = this.connection(hostId)
    const shot = await connection.api.deviceScreenshot(target)
    const asset = await connection.api.assetCreateUrl(undefined, { assetId: shot.assetId, name: 'device.png' })
    return new URL(asset.relativeUrl, connection.transport.serverUrl.replace(/^ws/, 'http')).toString()
  }
  forgetHost(hostId: string) {
    this.watches.get(hostId)?.stop(); this.watches.delete(hostId)
    this.states.delete(hostId); this.errors.delete(hostId); this.changes.notify()
  }
}
