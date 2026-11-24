import type { z } from 'zod'
import type { DocumentChange, DocumentKey, DocumentSyncStorage } from './document-sync'

/**
 * One personal document whose source is the person's home host while they are
 * signed out (ADR 0007 decision 2, docs/plans/personal-settings-source.md): the
 * settings, or the agent profile list. This reads the home host's copy when the
 * host is ready or says that it changed, and sends each change the person makes
 * here. A change made while the home host is away waits in storage, survives a
 * restart of the client, and goes when the host is back. Signed in, it does
 * nothing: the account is the source.
 */

/** The home host's calls for this document. */
export interface HomeHostDocumentCalls<D, K extends string> {
  get(): Promise<D>
  patch(change: DocumentChange<D, K>): Promise<D>
}

export interface HomeHostDocumentPorts<D, K extends string> {
  /** The home host while signed out (`personalSettingsHomeId`); null signed in, or with none. */
  homeHostId(): string | null
  /** The calls of a ready host; null when it is not ready. */
  callsFor(hostId: string): HomeHostDocumentCalls<D, K> | null
  /** The document on screen. */
  document(): D
  /** The home host's copy, with the changes that wait for it laid over it, replaces the copy on screen. */
  adopt(document: D): void
  /** Durable storage for the changes that wait for the home host. */
  storage: DocumentSyncStorage
  /** Where the changes that wait for one host are kept. */
  storageKey(hostId: string): string
  /** A stored waiting change; a value that no longer passes its schema is dropped. */
  pendingSchema: z.ZodType<DocumentChange<D, K>>
}

function same<V>(left: V, right: V): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Keys sorted, so two equal documents compare equal. */
function sorted<D extends object>(document: D): D {
  // SAFETY: the same entries of `document`, in another order.
  return Object.fromEntries(Object.entries(document).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) as D
}

export class HomeHostDocument<D extends object, K extends DocumentKey<D>> {
  /** The home host whose copy is on screen, once it was read since it became ready. */
  private readHostId: string | null = null
  private isSending = false
  private sendAgain = false

  constructor(private readonly ports: HomeHostDocumentPorts<D, K>, private readonly empty: () => D) {}

  /** A host connected or left, the home moved, or the person signed in or out. Reads the home host once it is ready. */
  refresh(): void {
    const homeId = this.ports.homeHostId()
    if (!homeId || !this.ports.callsFor(homeId)) {
      this.readHostId = null
      return
    }
    if (this.readHostId === homeId) return
    this.readHostId = homeId
    void this.sync()
  }

  /** The source moved (a sign-in or a sign-out): the home host is read again at the next refresh. */
  forget(): void {
    this.readHostId = null
  }

  /** The person changed the document here. It goes to the home host, now or when it is back. */
  recordLocalChange(change: DocumentChange<D, K>): void {
    const homeId = this.ports.homeHostId()
    if (!homeId) return
    const pending = this.pending(homeId)
    const setKeys = Object.keys(change.set)
    pending.reset = pending.reset.filter((key) => !setKeys.includes(key))
    Object.assign(pending.set, structuredClone(change.set))
    for (const key of change.reset) {
      delete pending.set[key]
      if (!pending.reset.includes(key)) pending.reset.push(key)
    }
    this.storePending(homeId, pending)
    void this.sync()
  }

  /** A host said that the person's copy there changed. */
  hostChanged(hostId: string): void {
    if (hostId === this.ports.homeHostId()) void this.sync()
  }

  /** Sends what waits, then shows the home host's copy. One at a time; a call during one runs once after it. */
  private async sync(): Promise<void> {
    if (this.isSending) {
      this.sendAgain = true
      return
    }
    const homeId = this.ports.homeHostId()
    const calls = homeId ? this.ports.callsFor(homeId) : null
    if (!homeId || !calls) return
    this.isSending = true
    try {
      const pending = this.pending(homeId)
      const hasPending = Object.keys(pending.set).length > 0 || pending.reset.length > 0
      const copy = hasPending ? await calls.patch(pending) : await calls.get()
      if (hasPending) this.dropSent(homeId, pending)
      // Signed in, or moved home, while the call ran: the copy is no longer the one on screen.
      if (this.ports.homeHostId() !== homeId) return
      const next = this.withPending(copy, this.pending(homeId))
      if (!same(sorted(next), sorted(this.ports.document()))) this.ports.adopt(next)
    } catch {
      // An older host, or a connection that dropped: the next refresh reads again, and what waits stays.
      this.readHostId = null
    } finally {
      this.isSending = false
      if (this.sendAgain) {
        this.sendAgain = false
        void this.sync()
      }
    }
  }

  /** `pending` laid over `copy`: what the person sees while their changes wait. */
  private withPending(copy: D, pending: DocumentChange<D, K>): D {
    const result = structuredClone(copy)
    for (const key of pending.reset) delete result[key]
    return Object.assign(result, structuredClone(pending.set))
  }

  /** The keys sent that the person has not changed again since stop waiting. */
  private dropSent(hostId: string, sent: DocumentChange<D, K>): void {
    const now = this.pending(hostId)
    for (const [key, value] of Object.entries(sent.set)) {
      if (Object.hasOwn(now.set, key) && same(Object.getOwnPropertyDescriptor(now.set, key)?.value, value)) Reflect.deleteProperty(now.set, key)
    }
    now.reset = now.reset.filter((key) => !sent.reset.includes(key))
    this.storePending(hostId, now)
  }

  private pending(hostId: string): DocumentChange<D, K> {
    const raw = this.ports.storage.getItem(this.ports.storageKey(hostId))
    const none = { set: this.empty(), reset: [] }
    if (!raw) return none
    try {
      const parsed = this.ports.pendingSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : none
    } catch {
      return none
    }
  }

  private storePending(hostId: string, pending: DocumentChange<D, K>): void {
    if (Object.keys(pending.set).length === 0 && pending.reset.length === 0) this.ports.storage.removeItem(this.ports.storageKey(hostId))
    else this.ports.storage.setItem(this.ports.storageKey(hostId), JSON.stringify(pending))
  }
}
