import { z } from 'zod'
import {
  agentProfileSchema,
  agentProfileEntrySchema,
  agentProfileKeyOf,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileKey,
  withoutRetiredEntries,
} from '@solus/contracts/agent-profile'
import {
  syncAccountKey,
  type SyncAccount,
} from '@solus/client-core/document-sync'
import type { AgentProfileChange } from '@solus/client-core/agent-profile-sync'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore } from '../../platform/ports'

/**
 * The person's agent profile on this device (plans/020-agent-profile.md §3,
 * ADR 0007): one copy of the entries per account, and one for nobody signed in.
 * The source is not here: signed in, it is the account (the sync owner moves
 * it); signed out, it is the home host (`personal-document-hosts.ts`). A phone
 * has no provider home to read, so the copy holds what the person adds, what
 * the host keeps, or what sync brings.
 */

const profileKey = (accountKey: string) => `solus.agent-profile.v1:${accountKey}`

const storedSchema = z.object({ entries: agentProfileSchema })

const storedJsonSchema = z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(storedSchema)

export type AgentProfileSetOutcome = 'saved' | 'invalid'

export class AgentProfileLocalStore {
  readonly changes = new Listeners()
  private accountKey = syncAccountKey(null)
  private stored: AgentProfile
  private readonly localChangeListeners = new Set<(change: AgentProfileChange) => void>()

  constructor(private readonly storage: KeyValueStore) {
    this.stored = this.load(this.accountKey) ?? {}
  }

  // ── Reading ──

  /** The entries of the account signed in. The same object until one changes. */
  entries = (): AgentProfile => this.stored

  /** What a sync seed or replace carries. */
  document(): AgentProfile {
    return structuredClone(this.stored)
  }

  /** Hears every change the person makes here; never a change that came from the cloud. */
  onLocalChange(listener: (change: AgentProfileChange) => void): () => void {
    this.localChangeListeners.add(listener)
    return () => { this.localChangeListeners.delete(listener) }
  }

  // ── Account ──

  /** Signed in: the account is the source of what shows. */
  get isSignedIn(): boolean {
    return this.accountKey !== syncAccountKey(null)
  }

  /**
   * Shows the copy of the account now signed in, or the anonymous one. A first
   * copy for an account starts as the anonymous one, which is the home host's:
   * the account takes it when it has none (ADR 0007 decision 3). Nothing is uploaded.
   */
  setAccount(account: SyncAccount | null): void {
    const accountKey = syncAccountKey(account)
    if (accountKey === this.accountKey) return
    const anonymous = this.load(syncAccountKey(null)) ?? {}
    this.accountKey = accountKey
    const stored = this.load(accountKey)
    this.stored = stored ?? (account ? anonymous : {})
    if (!stored) this.save()
    this.changes.notify()
  }

  /** Signed out: the home host's list replaces the one on screen. It is never sent back. */
  adoptHostCopy(entries: AgentProfile): void {
    if (this.isSignedIn) return
    this.stored = withoutRetiredEntries(structuredClone(entries))
    this.save()
    this.changes.notify()
  }

  // ── Writing ──

  /**
   * Entries the person made or changed, as one change: a hand-written skill's
   * files turn off and on together. Refused, all of them, when one fails the schema.
   */
  setEntry(entry: AgentProfileEntry | readonly AgentProfileEntry[]): AgentProfileSetOutcome {
    const set: AgentProfile = {}
    for (const candidate of Array.isArray(entry) ? entry : [entry]) {
      const parsed = agentProfileEntrySchema.safeParse(candidate)
      if (!parsed.success) return 'invalid'
      set[agentProfileKeyOf(parsed.data)] = parsed.data
    }
    const next = { ...this.stored, ...set }
    if (!agentProfileSchema.safeParse(next).success) return 'invalid'
    this.stored = next
    this.save()
    this.changes.notify()
    for (const listener of this.localChangeListeners) listener({ set: structuredClone(set), reset: [] })
    return 'saved'
  }

  /** Removes the entries at `keys`; keys the copy does not hold are ignored. */
  removeKeys(keys: readonly AgentProfileKey[]): void {
    const reset = keys.filter((key) => Object.hasOwn(this.stored, key))
    if (reset.length === 0) return
    const next = { ...this.stored }
    for (const key of reset) delete next[key]
    this.stored = next
    this.save()
    this.changes.notify()
    for (const listener of this.localChangeListeners) listener({ set: {}, reset })
  }

  /** A change confirmed by the cloud. Not reported back to sync. */
  applyRemote(change: AgentProfileChange): void {
    // A retired entry from another device or the account never lands here.
    const next = { ...this.stored, ...withoutRetiredEntries(structuredClone(change.set)) }
    for (const key of change.reset) delete next[key]
    this.stored = next
    this.save()
    this.changes.notify()
  }

  // ── Internals ──

  /** The stored copy of an account; null when it has none on this device. */
  private load(accountKey: string): AgentProfile | null {
    const raw = this.storage.getItem(profileKey(accountKey))
    if (!raw) return null
    const parsed = storedJsonSchema.safeParse(raw)
    return parsed.success ? withoutRetiredEntries(parsed.data.entries) : {}
  }

  private save(): void {
    this.storage.setItem(profileKey(this.accountKey), JSON.stringify({ entries: this.stored }))
  }
}
