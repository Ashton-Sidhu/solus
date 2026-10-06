import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { DialOutcome } from '@solus/client-core/host-supervisor'
import type { WsTransportOptions } from '@solus/client-core/ws-transport'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import { HostConnections, type HostTransport } from '../../../apps/mobile/src/features/hosts/host-connections'
import { HostRegistry } from '../../../apps/mobile/src/features/hosts/host-registry'
import { memoryKeyValueStore, memorySecretStore } from '../../../apps/mobile/src/platform/ports'

type Handler = (...args: never[]) => unknown

/** A host's RPC surface as a table of handlers; calls are recorded in order. */
export class FakeApi {
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  readonly handlers = new Map<string, Handler>()

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler)
    return this
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  surface(): object {
    return new Proxy({}, {
      get: (_target, property) => {
        const method = String(property)
        return async (...args: unknown[]) => {
          this.calls.push({ method, args })
          const handler = this.handlers.get(method)
          if (!handler) throw new Error(`unexpected call ${method}`)
          return (handler as (...values: unknown[]) => unknown)(...args)
        }
      },
    })
  }
}

export class FakeTransport implements HostTransport {
  readonly events = new HostEventSubscriber()
  serverUrl: string
  dials = 0
  destroyed = false
  private opened = false
  private report: ((outcome: DialOutcome) => void) | null = null
  private resetCallback: (() => void) | null = null

  constructor(readonly options: WsTransportOptions, readonly api: FakeApi) {
    this.serverUrl = options.serverUrl
  }

  start(): void { this.dials += 1 }
  async probe(): Promise<void> {}
  buildSolusApi(): object { return this.api.surface() }
  onReset(callback: () => void): () => void {
    this.resetCallback = callback
    return () => { this.resetCallback = null }
  }
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void { this.report = report }
  switchServerUrl(serverUrl: string): void { this.serverUrl = serverUrl }
  destroy(): void { this.destroyed = true }

  /** What the real transport does after a dial: verify identity, then report. */
  async accept(recovered = false): Promise<void> {
    const ok = this.options.verifyConnectedHost ? await this.options.verifyConnectedHost() : true
    if (!ok) {
      this.report?.({ kind: 'identity-mismatch' })
      return
    }
    // As in WsTransport: only a later connection that lost its server session resets.
    if (this.opened && !recovered) this.resetCallback?.()
    this.opened = true
    this.report?.({ kind: 'accepted', recovered })
  }

  fail(kind: 'dial-failed' | 'dropped' | 'auth-blocked'): void {
    this.report?.({ kind })
  }

  emit<K extends keyof HostEventMap>(type: K, payload: HostEventMap[K]): void {
    this.events.receive({ type, payload, occurredAt: Date.now() })
  }

  emitSession(sessionId: string, event: WireNormalizedEvent): void {
    this.emit('session.eventReceived', { sessionId, event })
  }
}

/** Timers the test advances by hand: no sleeps. */
export class ManualTimers {
  private next = 1
  readonly pending = new Map<number, () => void>()
  setTimeoutFn = ((callback: () => void) => {
    const id = this.next++
    this.pending.set(id, callback)
    return id
  }) as unknown as typeof setTimeout
  clearTimeoutFn = ((id: number) => { this.pending.delete(id) }) as unknown as typeof clearTimeout
  runAll(): void {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    for (const callback of callbacks) callback()
  }
}

export function healthFetch(installationIds: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const base = url.replace(/\/health$/, '')
    const installationId = installationIds[base]
    if (!installationId) throw new Error('unreachable')
    return new Response(JSON.stringify({ ok: true, installationId, name: 'Studio Mac', os: 'macos' }), { status: 200 })
  }) as typeof fetch
}

export function createHostWorld(options: { fetch?: typeof fetch; api?: () => FakeApi } = {}) {
  const storage = memoryKeyValueStore()
  const secrets = memorySecretStore()
  const registry = new HostRegistry(storage, secrets)
  const timers = new ManualTimers()
  const transports: FakeTransport[] = []
  const grants: string[] = []
  const grantOptions: Array<{ fresh?: boolean } | undefined> = []
  const connections = new HostConnections({
    registry,
    createTransport: (transportOptions) => {
      const transport = new FakeTransport(transportOptions, options.api?.() ?? new FakeApi())
      transports.push(transport)
      return transport
    },
    acquireHostAccessToken: async (host, options) => {
      grants.push(host.id)
      grantOptions.push(options)
      return `grant-for-${host.id}`
    },
    organizationId: () => null,
    fetch: options.fetch ?? healthFetch({}),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { storage, secrets, registry, connections, transports, timers, grants, grantOptions }
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
