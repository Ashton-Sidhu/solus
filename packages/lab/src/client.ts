import { randomBytes } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { HostEvent } from '@solus/contracts/host-events'
import type { HostKind } from '@solus/contracts/uplink'
import type { LabIssuer } from './issuer'
import type { Persona } from './personas'

/**
 * One persona's connection to the Lab host (plan §8.2). It walks the real admission
 * path: a fresh grant per dial, exchanged at `/auth/ws-ticket` (with the share secret
 * for a guest) for a one-use ticket that rides the socket handshake. RPC answers and
 * host events come back typed; a refusal keeps its code so a scenario can assert it.
 */

const envelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
})
type RpcEnvelopeInput = z.input<typeof envelopeSchema>

export class LabRpcError extends Error {
  constructor(readonly method: string, readonly code: string | undefined, message: string) {
    super(message)
    this.name = 'LabRpcError'
  }
}

export type DialOutcome =
  | { ok: true }
  | { ok: false; stage: 'ticket'; status: number }
  | { ok: false; stage: 'socket'; code: string | null }

export interface LabClientOptions {
  persona: Persona
  /** The proxied listener, or the ordinary one for a local-owner route. */
  hostUrl: string
  issuer: LabIssuer
  hostId: string
  hostKind: HostKind
  hostOwnerUserId?: string
  /** A guest presents the link secret with its grant. */
  shareSecret?: string
  /** No grant at all: a trusted loopback caller, the local owner (personal hosts). */
  credentialFree?: boolean
  /** Seconds; a short grant proves the expiry disconnect. */
  grantTtlSeconds?: number
  onTimeline?: (entry: TimelineEntry) => void
}

export interface TimelineEntry {
  at: number
  persona: string
  kind: 'dial' | 'rpc' | 'event' | 'disconnect'
  method?: string
  ok?: boolean
  code?: string
  detail?: unknown
}

type RpcArgs<M extends RpcInvokeMethod> = Parameters<SolusAPI[M]>
type RpcResult<M extends RpcInvokeMethod> = Awaited<ReturnType<SolusAPI[M]>>

export class LabClient {
  readonly persona: Persona
  private socket: Socket | null = null
  private readonly events: HostEvent[] = []
  private readonly eventWaiters: Array<(event: HostEvent) => void> = []
  private disconnectedAt: number | null = null
  private readonly disconnectWaiters: Array<() => void> = []
  private readonly clientInstanceId = `lab-${randomBytes(12).toString('hex')}`

  constructor(private readonly options: LabClientOptions) {
    this.persona = options.persona
  }

  get connected(): boolean {
    return this.socket?.connected ?? false
  }

  /** Mints a grant and exchanges it for one ticket; null with the refusal status. */
  async fetchTicket(): Promise<{ ticket: string } | { status: number }> {
    const grant = this.options.issuer.mint(this.persona, {
      hostId: this.options.hostId,
      hostKind: this.options.hostKind,
      hostOwnerUserId: this.options.hostOwnerUserId,
      ttlSeconds: this.options.grantTtlSeconds,
    })
    const response = await fetch(`${this.options.hostUrl}/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.options.shareSecret ? { shareSecret: this.options.shareSecret } : {}),
    })
    if (!response.ok) return { status: response.status }
    const body = z.object({ ticket: z.string().min(1) }).parse(await response.json())
    return { ticket: body.ticket }
  }

  async connect(): Promise<DialOutcome> {
    let ticket: string | undefined
    if (!this.options.credentialFree) {
      const outcome = await this.fetchTicket()
      if ('status' in outcome) {
        this.timeline({ kind: 'dial', ok: false, code: `ticket:${outcome.status}` })
        return { ok: false, stage: 'ticket', status: outcome.status }
      }
      ticket = outcome.ticket
    }
    return this.dial(ticket)
  }

  /** Dials with a ticket the caller already holds (to prove a ticket admits one socket only). */
  dial(ticket: string | undefined): Promise<DialOutcome> {
    this.disconnectedAt = null
    const socket = io(this.options.hostUrl, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      auth: ticket ? { ticket, clientInstanceId: this.clientInstanceId } : { clientInstanceId: this.clientInstanceId },
    })
    socket.on('host-event', (event: HostEvent) => {
      this.events.push(event)
      this.timeline({ kind: 'event', method: event.type, detail: event.payload })
      // A satisfied waiter removes itself, so iterate a copy.
      for (const waiter of Array.from(this.eventWaiters)) waiter(event)
    })
    socket.on('disconnect', (reason) => {
      this.disconnectedAt = Date.now()
      this.timeline({ kind: 'disconnect', detail: reason })
      for (const waiter of this.disconnectWaiters.splice(0)) waiter()
    })
    return new Promise((resolveOutcome) => {
      const timeout = setTimeout(() => finish({ ok: false, stage: 'socket', code: 'timeout' }), 10_000)
      const finish = (outcome: DialOutcome) => {
        clearTimeout(timeout)
        socket.off('connect', onConnect)
        socket.off('connect_error', onError)
        if (outcome.ok) this.socket = socket
        else socket.disconnect()
        this.timeline({ kind: 'dial', ok: outcome.ok, code: outcome.ok ? undefined : 'code' in outcome ? outcome.code ?? undefined : String(outcome.status) })
        resolveOutcome(outcome)
      }
      const onConnect = () => finish({ ok: true })
      const onError = (error: Error & { data?: { code?: string } }) => finish({ ok: false, stage: 'socket', code: error.data?.code ?? null })
      socket.once('connect', onConnect)
      socket.once('connect_error', onError)
    })
  }

  async rpc<M extends RpcInvokeMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>> {
    const socket = this.socket
    if (!socket?.connected) throw new LabRpcError(method, 'DISCONNECTED', `${this.persona.id} is not connected`)
    return new Promise<RpcResult<M>>((resolveResult, reject) => {
      const requestId = randomBytes(8).toString('hex')
      const timeout = setTimeout(() => reject(new LabRpcError(method, 'TIMEOUT', `${method} timed out`)), 30_000)
      socket.emit('rpc', requestId, method, args, (raw: RpcEnvelopeInput) => {
        clearTimeout(timeout)
        const envelope = envelopeSchema.safeParse(raw)
        if (!envelope.success) return reject(new LabRpcError(method, 'BAD_ENVELOPE', `${method} answered with an unreadable envelope`))
        if (envelope.data.error) {
          this.timeline({ kind: 'rpc', method, ok: false, code: envelope.data.error.code })
          return reject(new LabRpcError(method, envelope.data.error.code, envelope.data.error.message ?? `${method} failed`))
        }
        this.timeline({ kind: 'rpc', method, ok: true })
        // SAFETY: the host answered method M, so the result has M's return type; the wire cannot prove it and the scenario's generic already assumed it.
        const result = envelope.data.result as RpcResult<M>
        resolveResult(result)
      })
    })
  }

  /** The events received so far, of one type. */
  received<K extends HostEvent['type']>(type: K): Array<Extract<HostEvent, { type: K }>> {
    return this.events.filter((event): event is Extract<HostEvent, { type: K }> => event.type === type)
  }

  waitForEvent<K extends HostEvent['type']>(type: K, matches: (event: Extract<HostEvent, { type: K }>) => boolean = () => true, timeoutMs = 5_000): Promise<Extract<HostEvent, { type: K }>> {
    const already = this.received(type).find(matches)
    if (already) return Promise.resolve(already)
    return new Promise((resolveEvent, reject) => {
      const timeout = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter)
        if (index >= 0) this.eventWaiters.splice(index, 1)
        reject(new Error(`${this.persona.id} did not receive ${type} within ${timeoutMs} ms`))
      }, timeoutMs)
      const waiter = (event: HostEvent) => {
        if (event.type !== type) return
        // SAFETY: the `type` check above narrows the distributive union to this member.
        const typed = event as Extract<HostEvent, { type: K }>
        if (!matches(typed)) return
        clearTimeout(timeout)
        const index = this.eventWaiters.indexOf(waiter)
        if (index >= 0) this.eventWaiters.splice(index, 1)
        resolveEvent(typed)
      }
      this.eventWaiters.push(waiter)
    })
  }

  /** Resolves when the host ends the socket; rejects when it stays open past the timeout. */
  waitForDisconnect(timeoutMs: number): Promise<number> {
    if (this.disconnectedAt !== null) return Promise.resolve(this.disconnectedAt)
    if (!this.socket) return Promise.reject(new Error(`${this.persona.id} never connected`))
    return new Promise((resolveAt, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${this.persona.id}'s socket stayed open for ${timeoutMs} ms`)), timeoutMs)
      this.disconnectWaiters.push(() => { clearTimeout(timeout); resolveAt(this.disconnectedAt ?? Date.now()) })
    })
  }

  close(): void {
    this.socket?.disconnect()
    this.socket = null
  }

  private timeline(entry: Omit<TimelineEntry, 'at' | 'persona'>): void {
    this.options.onTimeline?.({ at: Date.now(), persona: this.persona.id, ...entry })
  }
}
