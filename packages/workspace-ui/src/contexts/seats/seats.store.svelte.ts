import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { localApi } from '@solus/client-core/local-api'
import { seatProviderSchema, type SeatConnectStartResult, type SeatProvider, type SeatStatus } from '@solus/contracts/seats'
import type { AgentId } from '@solus/contracts/types'
import { sharesStore } from '../sharing/shares.store.svelte'
import { toasts } from '../../lib/toasts'

/**
 * Provider seats per host (Step 2 plan §3.6): the caller's own Claude and Codex
 * logins on a shared host. The host owns the credential and the state; this store
 * caches what it answered, re-reads on `host.seatChanged`, drives the relayed
 * connect, and holds the one interrupt a refused prompt raises.
 */

/** A prompt the host refused with `SEAT_REQUIRED`: the card stands in that conversation. */
export interface SeatRequest {
  serverId: string
  sessionId: string
  provider: SeatProvider
}

/** A login the person called off, so the wizard reports no failure for the cancel it asked for. */
export class SeatConnectCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled.')
    this.name = 'SeatConnectCancelled'
  }
}

function seatKey(serverId: string, provider: SeatProvider): string {
  return `${serverId}|${provider}`
}

export function seatProviderOf(provider: AgentId | null | undefined): SeatProvider | null {
  const parsed = seatProviderSchema.safeParse(provider)
  return parsed.success ? parsed.data : null
}

class SeatsStore {
  /** serverId → the caller's seats, as the host last listed them. */
  readonly seats = new SvelteMap<string, SeatStatus[]>()
  /** serverId → whether this client holds seats there: the owner (the host login is theirs) and members do, a guest does not. */
  readonly hasSeats = new SvelteMap<string, boolean>()
  /** A relayed login in progress: where to sign in, per host and provider. */
  readonly verifications = new SvelteMap<string, SeatConnectStartResult>()
  /** Why the last connect attempt ended without a seat, per host and provider. */
  readonly errors = new SvelteMap<string, string>()
  required = $state<SeatRequest | null>(null)
  /** The seat a call is in flight for, so a row cannot be double-submitted. */
  busy = $state<string | null>(null)
  private readonly loads = new Map<string, Promise<void>>()
  /** Callers waiting for a login to end, settled by `host.seatChanged`. */
  private readonly settleWaiters = new Map<string, Array<(state: SeatStatus['state'], error?: string) => void>>()
  private stopListening: (() => void) | null = null

  statusFor(serverId: string, provider: SeatProvider): SeatStatus | undefined {
    return this.seats.get(serverId)?.find((seat) => seat.provider === provider)
  }

  verificationFor(serverId: string, provider: SeatProvider): SeatConnectStartResult | undefined {
    return this.verifications.get(seatKey(serverId, provider))
  }

  errorFor(serverId: string, provider: SeatProvider): string | undefined {
    return this.errors.get(seatKey(serverId, provider))
  }

  isBusy(serverId: string, provider: SeatProvider): boolean {
    return this.busy === seatKey(serverId, provider)
  }

  /**
   * Whether this host shows seats to this client at all: only an organization
   * member has a seat of their own. The owner's seat is the host login, which
   * Connections → host → AI providers already manages.
   */
  async ensure(serverId: string): Promise<void> {
    if (this.hasSeats.has(serverId)) return
    const inFlight = this.loads.get(serverId)
    if (inFlight) return inFlight
    const load = (async () => {
      const identity = await sharesStore.identityFor(serverId).catch(() => null)
      const eligible = identity?.principal === 'org-member'
      this.hasSeats.set(serverId, eligible)
      if (eligible) await this.load(serverId)
    })().finally(() => { this.loads.delete(serverId) })
    this.loads.set(serverId, load)
    return load
  }

  async load(serverId: string): Promise<void> {
    try {
      const seats = await serverConnections.apiFor(serverId).seatList()
      this.seats.set(serverId, seats)
      for (const seat of seats) {
        if (seat.state !== 'connecting') this.verifications.delete(seatKey(serverId, seat.provider))
      }
    } catch {
      // An older host, or a connection that dropped: the rows keep their last answer.
    }
  }

  /** Called once at boot: a seat's state changes on the host, in the browser, or at a turn's end. */
  listen(): () => void {
    if (this.stopListening) return this.stopListening
    this.stopListening = subscribeAllHosts('host.seatChanged', (serverId, event) => {
      const key = seatKey(serverId, event.provider)
      if (event.error) this.errors.set(key, event.error)
      else if (event.state === 'connected' || event.state === 'connecting') this.errors.delete(key)
      if (event.state !== 'connecting') {
        this.verifications.delete(key)
        for (const settle of this.settleWaiters.get(key)?.splice(0) ?? []) settle(event.state, event.error)
      }
      void this.load(serverId)
    })
    return () => {
      this.stopListening?.()
      this.stopListening = null
    }
  }

  /** Starts the provider's login on the host and opens where to sign in on this device. */
  async connect(serverId: string, provider: SeatProvider): Promise<void> {
    const key = seatKey(serverId, provider)
    await this.run(key, async () => {
      this.errors.delete(key)
      const verification = await serverConnections.apiFor(serverId).seatConnectStart({ provider })
      this.verifications.set(key, verification)
      await this.load(serverId)
      // The sign-in happens in the browser on this device, never on the host.
      void localApi.openExternal(verification.verificationUrl)
    })
  }

  /**
   * Connect and wait for the login to end, as the setup wizard does: resolves on a
   * connected seat, throws with the host's reason otherwise, and throws
   * `SeatConnectCancelled` for a cancel the person asked for.
   */
  async connectAndWait(serverId: string, provider: SeatProvider): Promise<void> {
    const key = seatKey(serverId, provider)
    const settled = new Promise<{ state: SeatStatus['state']; error?: string }>((resolve) => {
      const waiters = this.settleWaiters.get(key) ?? []
      waiters.push((state, error) => resolve({ state, error }))
      this.settleWaiters.set(key, waiters)
    })
    await this.connect(serverId, provider)
    if (this.errors.has(key) && !this.verifications.has(key)) throw new Error(this.errors.get(key))
    const outcome = await settled
    if (outcome.state === 'connected') return
    if (outcome.error?.toLowerCase().includes('cancelled')) throw new SeatConnectCancelled()
    throw new Error(outcome.error ?? `${provider === 'claude-code' ? 'Claude' : 'Codex'} did not sign in.`)
  }

  async submitCode(serverId: string, provider: SeatProvider, code: string): Promise<void> {
    await serverConnections.apiFor(serverId).seatConnectSubmitCode({ provider, code })
  }

  async cancel(serverId: string, provider: SeatProvider): Promise<void> {
    const key = seatKey(serverId, provider)
    await this.run(key, async () => {
      await serverConnections.apiFor(serverId).seatConnectCancel({ provider })
      this.verifications.delete(key)
      await this.load(serverId)
    })
  }

  async connectToken(serverId: string, provider: SeatProvider, token: string): Promise<void> {
    const key = seatKey(serverId, provider)
    await this.run(key, async () => {
      this.errors.delete(key)
      await serverConnections.apiFor(serverId).seatConnectToken({ provider, token })
      this.verifications.delete(key)
      await this.load(serverId)
    })
  }

  async disconnect(serverId: string, provider: SeatProvider): Promise<void> {
    const key = seatKey(serverId, provider)
    await this.run(key, async () => {
      await serverConnections.apiFor(serverId).seatDisconnect({ provider })
      this.verifications.delete(key)
      await this.load(serverId)
    })
  }

  /** The host refused a prompt for want of a seat: the card stands in that conversation. */
  noteRefusal(serverId: string, sessionId: string, provider: SeatProvider): void {
    this.required = { serverId, sessionId, provider }
    this.hasSeats.set(serverId, true)
    void this.load(serverId)
  }

  visibleFor(serverId: string | undefined, sessionId: string): boolean {
    const required = this.required
    return required !== null && required.serverId === serverId && required.sessionId === sessionId
  }

  dismiss(): void {
    this.required = null
  }

  private async run(key: string, change: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = key
    try {
      await change()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not change the seat'
      this.errors.set(key, message)
      toasts.error(message)
    } finally {
      this.busy = null
    }
  }
}

export const seatsStore = new SeatsStore()
