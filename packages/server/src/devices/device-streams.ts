import type { DeviceInput } from '@solus/contracts/device-types'
import { DeviceLink, type DeviceLinkTarget, type DeviceServerSink, type DeviceVideoFormat } from './device-link'
import type { DeviceFrameChannel } from './device-frame-channel'
import type { DeviceUpstream } from './device-upstream'
import type { DeviceControlTarget } from './device-control'

const linkKey = (target: DeviceControlTarget) => `${target.deviceHostId}\u0000${target.deviceId}`

/**
 * Every live device link on this host, keyed by device host and device. A
 * link starts on the first watcher, recorder or input, and ends when the last
 * of those leaves; the device itself keeps running.
 */
export class DeviceStreams {
  private readonly links = new Map<string, DeviceLink>()
  private generation: number

  constructor(
    private readonly channel: DeviceFrameChannel,
    private readonly upstream: DeviceUpstream,
    private readonly now: () => number = Date.now,
  ) {
    this.generation = now()
  }

  private link(target: DeviceLinkTarget): DeviceLink {
    const key = linkKey(target)
    const existing = this.links.get(key)
    // A link to an old hub origin (helper restarted, host edited) is replaced.
    if (existing && !existing.isClosed && existing.target.hubOrigin === target.hubOrigin) return existing
    existing?.close('The device stream restarted.')
    const link = new DeviceLink(target, {
      channel: this.channel,
      upstream: this.upstream,
      nextGeneration: () => ++this.generation,
      now: this.now,
    })
    this.links.set(key, link)
    return link
  }

  get(target: DeviceControlTarget): DeviceLink | undefined {
    const link = this.links.get(linkKey(target))
    return link && !link.isClosed ? link : undefined
  }

  subscribe(clientId: string, target: DeviceLinkTarget, format: DeviceVideoFormat): void {
    this.link(target).subscribe(clientId, format)
  }

  unsubscribe(clientId: string, target: DeviceControlTarget): void {
    const link = this.get(target)
    if (!link) return
    link.unsubscribe(clientId)
    this.closeIfIdle(link)
  }

  addSink(target: DeviceLinkTarget, sink: DeviceServerSink): DeviceLink {
    const link = this.link(target)
    link.addSink(sink)
    return link
  }

  removeSink(target: DeviceControlTarget, sink: DeviceServerSink): void {
    const link = this.get(target)
    if (!link) return
    link.removeSink(sink)
    this.closeIfIdle(link)
  }

  async input(clientId: string, target: DeviceLinkTarget, inputs: DeviceInput[], screenGeneration: number): Promise<void> {
    const link = this.link(target)
    try {
      await link.input(clientId, inputs, screenGeneration)
    } finally {
      this.closeIfIdle(link)
    }
  }

  screenGeneration(target: DeviceControlTarget): number {
    return this.get(target)?.screenGeneration ?? 0
  }

  /** A client disconnected: release any pointer it holds. Subscriptions wait for expiry. */
  async cancelInput(clientId: string): Promise<void> {
    for (const link of this.links.values()) {
      await link.cancelInput(clientId)
      this.closeIfIdle(link)
    }
  }

  /** A client expired or lost access: everything it watched stops. */
  async dropClient(clientId: string): Promise<void> {
    for (const link of this.links.values()) {
      await link.cancelInput(clientId)
      link.unsubscribe(clientId)
      this.closeIfIdle(link)
    }
  }

  /** Devices that went away end their links with a reason every watcher sees. */
  end(predicate: (target: DeviceControlTarget) => boolean, reason: string): void {
    for (const [key, link] of this.links) {
      if (!predicate(link.target)) continue
      link.close(reason)
      this.links.delete(key)
    }
  }

  /** Clients currently watching a device; shown as other active use. */
  watchers(target: DeviceControlTarget): string[] {
    return this.get(target)?.watchers() ?? []
  }

  private closeIfIdle(link: DeviceLink): void {
    if (!link.isIdle()) return
    link.close('No one is watching.')
    const key = linkKey(link.target)
    if (this.links.get(key) === link) this.links.delete(key)
  }

  closeAll(): void {
    this.end(() => true, 'The host is shutting down.')
  }
}
