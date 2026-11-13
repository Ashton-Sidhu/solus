import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { UplinkEnrollmentTicket } from '@solus/contracts/uplink'
import { serversStore } from '../../contexts'

/** How often the directory is read while a link code waits for its machine. */
const LINK_POLL_MS = 3_000

/**
 * "Link a machine you own" (docs/plans/host-fleet.md D8): a one-time link code from
 * the account, and a watch of the directory until a machine this client did not
 * list before appears. The code ends after ten minutes; the watch ends with it.
 */
class LinkMachineStore {
  ticket = $state<UplinkEnrollmentTicket | null>(null)
  error = $state<string | null>(null)
  /** The machine the code linked, once the directory lists it. */
  linkedLabel = $state<string | null>(null)
  /** The directory is read until the machine appears or the code ends. */
  isWaiting = $state(false)
  #poll: ReturnType<typeof setInterval> | null = null

  /** Only a client with an account can give a link code. */
  get isAvailable(): boolean {
    return uplinkAccountSource() !== null
  }

  async request(): Promise<void> {
    const source = uplinkAccountSource()
    if (!source) return
    this.error = null
    this.linkedLabel = null
    const ticket = await source.issueEnrollmentTicket()
    if (!ticket) {
      this.error = 'Solus Cloud did not give a link code. Try again.'
      return
    }
    this.ticket = ticket
    this.watch()
  }

  stop(): void {
    if (this.#poll) clearInterval(this.#poll)
    this.#poll = null
    this.isWaiting = false
  }

  private watch(): void {
    this.stop()
    const known = new Set(serversStore.servers.map((server) => server.id))
    this.isWaiting = true
    this.#poll = setInterval(() => {
      if (!this.ticket || Date.now() > this.ticket.expiresAt) {
        this.ticket = null
        this.stop()
        return
      }
      void serversStore.refreshDirectory().then(() => {
        const linked = serversStore.servers.find((server) => !known.has(server.id))
        if (!linked) return
        this.linkedLabel = linked.label
        this.ticket = null
        this.stop()
      })
    }, LINK_POLL_MS)
  }
}

export const linkMachineStore = new LinkMachineStore()
