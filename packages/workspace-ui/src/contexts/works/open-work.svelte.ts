import type { Work } from '@solus/contracts/types'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostPhase } from '@solus/client-core/host-supervisor'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'

/**
 * `loading` until the first read answers; `ready` once a saved record is held;
 * `error` when the first read failed and nothing is held; `unavailable` when
 * the host says the work is gone or the reader can no longer open it.
 */
export type OpenWorkStatus = 'loading' | 'ready' | 'error' | 'unavailable'
export type UnavailableReason = 'deleted' | 'no-access'

/** One host as an open work uses it. The store binds it to a server id. */
export interface OpenWorkHost {
  readonly serverId: string
  readonly api: Pick<HostApi, 'loadWork'>
  subscribe<K extends HostEventName>(type: K, listener: (payload: HostEventMap[K]) => void): () => void
  onPhaseChange(listener: (phase: HostPhase) => void): () => void
  phase(): HostPhase | undefined
}

/** The store's side: its one saved record per work, and the guarded way in. */
export interface OpenWorkRecords {
  /** The held record, when it was read from `serverId`. */
  saved(workId: string, serverId: string): Work | undefined
  /** Apply a host answer in place when it is newer than the held record. */
  accept(work: Work, serverId: string): void
}

/** A listener sees every accepted change to the saved record. */
export type SavedListener = (work: Work, serverId: string) => void

/**
 * The live state of one work that at least one pane has open: bound to the
 * host that owns it, subscribed to that host's `works.changed` before its
 * first read, and re-read on each newer change, on a share change that can
 * remove access, and on reconnect. Reads never overlap: a change during a read
 * asks for one more read after it. The saved record itself is the store's.
 */
export class OpenWork {
  status = $state<OpenWorkStatus>('loading')
  unavailableReason = $state<UnavailableReason | null>(null)
  /** Why the last read failed. With a held record, the reader sees that copy is not current. */
  error = $state<string | null>(null)
  reconnecting = $state(false)
  refreshing = $state(false)
  refs = 0

  private host: OpenWorkHost | null = null
  private stops: (() => void)[] = []
  private generation = 0
  private reading: Promise<void> | null = null
  private readAgain = false
  private readonly listeners = new Set<SavedListener>()

  constructor(readonly workId: string, private readonly records: OpenWorkRecords) {}

  get serverId(): string | null {
    return this.host?.serverId ?? null
  }

  /** Subscribe on `host`, then read. A previous host is released first. */
  bind(host: OpenWorkHost): void {
    this.stop()
    this.host = host
    this.status = this.records.saved(this.workId, host.serverId) ? 'ready' : 'loading'
    this.unavailableReason = null
    this.error = null
    const phase = host.phase()
    this.reconnecting = phase !== undefined && phase !== 'connected'
    this.stops.push(
      host.subscribe('works.changed', (change) => {
        if (change.workId !== this.workId) return
        if (change.deleted) this.markUnavailable('deleted')
        else if (this.isNewer(host.serverId, change)) void this.refresh()
      }),
      host.subscribe('share.changed', (change) => {
        if (change.resource.kind === 'work' && change.resource.id === this.workId) void this.refresh()
      }),
      host.onPhaseChange((next) => {
        if (next !== 'connected') {
          this.reconnecting = true
          return
        }
        if (!this.reconnecting) return
        this.reconnecting = false
        void this.refresh()
      }),
    )
    void this.refresh()
  }

  /** Stop listening and drop any read in flight. The saved record stays. */
  stop(): void {
    this.generation++
    for (const stop of this.stops.splice(0)) stop()
    this.reading = null
    this.readAgain = false
    this.refreshing = false
  }

  /** Re-read the saved record. A call during a read queues exactly one more. */
  refresh(): Promise<void> {
    if (!this.host || this.status === 'unavailable') return Promise.resolve()
    if (this.reading) {
      this.readAgain = true
      return this.reading
    }
    const generation = this.generation
    const reading = this.readUntilCurrent(this.host, generation).finally(() => {
      if (generation === this.generation) {
        this.reading = null
        this.refreshing = false
      }
    })
    this.reading = reading
    return reading
  }

  /** The reader asked again after the work became unavailable, or a read failed. */
  retry(): void {
    if (this.host && this.status === 'unavailable') this.bind(this.host)
    else void this.refresh()
  }

  onSaved(listener: SavedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The store accepted a newer saved record for this work. */
  notify(work: Work, serverId: string): void {
    for (const listener of this.listeners) listener(work, serverId)
  }

  /** A write was refused because the host no longer has the work. */
  markUnavailable(reason: UnavailableReason): void {
    this.stop()
    this.status = 'unavailable'
    this.unavailableReason = reason
  }

  private isNewer(serverId: string, change: HostEventMap['works.changed']): boolean {
    const saved = this.records.saved(this.workId, serverId)
    if (!saved) return true
    return change.contentVersion > saved.contentVersion || Date.parse(change.version) > Date.parse(saved.updatedAt)
  }

  private async readUntilCurrent(host: OpenWorkHost, generation: number): Promise<void> {
    this.refreshing = true
    do {
      this.readAgain = false
      await this.readOnce(host, generation)
    } while (this.readAgain && generation === this.generation)
  }

  private async readOnce(host: OpenWorkHost, generation: number): Promise<void> {
    try {
      const work = await host.api.loadWork(this.workId)
      if (generation !== this.generation) return
      if (!work) {
        this.markUnavailable('deleted')
        return
      }
      this.records.accept(work, host.serverId)
      this.status = 'ready'
      this.error = null
    } catch (error) {
      if (generation !== this.generation) return
      const reason = unavailableReasonOf(error)
      if (reason) {
        this.markUnavailable(reason)
        return
      }
      this.error = error instanceof Error ? error.message : String(error)
      if (!this.records.saved(this.workId, host.serverId)) this.status = 'error'
    }
  }
}

/** Why the host refused the reader, or null for a failed transport: a 404 is a
 *  work that is gone, a 403 one the reader can no longer open. */
export function unavailableReasonOf(error: Parameters<typeof String>[0]): UnavailableReason | null {
  if (error instanceof WorkspaceRequestError) return error.status === 404 ? 'deleted' : error.status === 403 ? 'no-access' : null
  return error instanceof Error && rpcErrorCode(error) === 'FORBIDDEN' ? 'no-access' : null
}

/** A write refused because the saved body moved past the one it was based on. */
export function isStaleWrite(error: Parameters<typeof String>[0]): boolean {
  return error instanceof WorkspaceRequestError && error.status === 412
}
