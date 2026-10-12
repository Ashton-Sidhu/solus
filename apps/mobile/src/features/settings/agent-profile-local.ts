import { z } from 'zod'
import {
  agentProfileSchema,
  agentProfileEntrySchema,
  agentProfileKeyOf,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileKey,
} from '@solus/contracts/agent-profile'
import {
  syncAccountKey,
  type SyncAccount,
} from '@solus/client-core/document-sync'
import type { AgentProfileChange } from '@solus/client-core/agent-profile-sync'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore } from '../../platform/ports'

/**
 * The person's agent profile on this device (plans/020-agent-profile.md §3):
 * one local copy of the entries per account. It is the source of truth here,
 * and the account document is its replica, kept by the sync owner. A phone has
 * no provider home to read, so the copy starts empty and holds what the person
 * adds here or what sync brings.
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
    this.stored = this.load(this.accountKey)
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

  /** Shows the copy of the account now signed in, or the anonymous one. Nothing is uploaded. */
  setAccount(account: SyncAccount | null): void {
    const accountKey = syncAccountKey(account)
    if (accountKey === this.accountKey) return
    this.accountKey = accountKey
    this.stored = this.load(accountKey)
    this.changes.notify()
  }

  // ── Writing ──

  /** An entry the person made or changed. Refused when it fails the schema. */
  setEntry(entry: AgentProfileEntry): AgentProfileSetOutcome {
    const parsed = agentProfileEntrySchema.safeParse(entry)
    if (!parsed.success) return 'invalid'
    const key = agentProfileKeyOf(parsed.data)
    const next = { ...this.stored, [key]: parsed.data }
    if (!agentProfileSchema.safeParse(next).success) return 'invalid'
    this.stored = next
    this.save()
    this.changes.notify()
    for (const listener of this.localChangeListeners) listener({ set: { [key]: structuredClone(parsed.data) }, reset: [] })
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
    const next = { ...this.stored, ...structuredClone(change.set) }
    for (const key of change.reset) delete next[key]
    this.stored = next
    this.save()
    this.changes.notify()
  }

  // ── Internals ──

  private load(accountKey: string): AgentProfile {
    const raw = this.storage.getItem(profileKey(accountKey))
    if (!raw) return {}
    const parsed = storedJsonSchema.safeParse(raw)
    return parsed.success ? parsed.data.entries : {}
  }

  private save(): void {
    this.storage.setItem(profileKey(this.accountKey), JSON.stringify({ entries: this.stored }))
  }
}
