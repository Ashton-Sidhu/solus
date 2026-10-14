import { agentProfileFrom, type AgentProfile, type AgentProfileEntry, type AgentProfileKey } from '@solus/contracts/agent-profile'
import { agentProfileChangeBetween, type AgentProfileChange } from '@solus/client-core/agent-profile-sync'
import {
  ANONYMOUS_AGENT_PROFILE,
  applyChange,
  isEmptyChange,
  readStoredEntries,
  removeStoredEntries,
  writeStoredEntries,
} from './lib/agent-profile-local'

/**
 * This client's copy of the person's agent profile (plans/020-agent-profile.md
 * §3): one record per account, and an anonymous one while signed out. It is
 * the source of truth on this client; the account document is its optional
 * replica, moved by `AgentProfileSyncStore`. The Settings page edits it, and
 * on the desktop "Copy now" pushes it. Nothing here talks to a host.
 */
export class AgentProfileLocalStore {
  /** Every entry, by key. Mutated one key at a time. */
  entries = $state<AgentProfile>({})
  /** The record on screen: `origin|userId`, or `anonymous`. */
  accountKey = $state(ANONYMOUS_AGENT_PROFILE)
  private readonly listeners = new Set<(change: AgentProfileChange) => void>()

  constructor(private readonly storage: Storage = localStorage) {
    this.entries = readStoredEntries(storage, ANONYMOUS_AGENT_PROFILE) ?? {}
  }

  /** The entries as a plain document: the seed a first sync offers, the push a copy sends. */
  get storedEntries(): AgentProfile {
    return $state.snapshot(this.entries)
  }

  get entryCount(): number {
    return Object.keys(this.entries).length
  }

  /** The person's own edits here. Sync applies what the cloud confirms without this. */
  onLocalChange(listener: (change: AgentProfileChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Cloud changes sync confirmed. Never an echo of this client's own edit. */
  applyRemote(change: AgentProfileChange): void {
    applyChange(this.entries, change)
    this.persist()
  }

  /** The whole copy becomes `entries`, as one change: what a first sync or a copy from this computer leaves. */
  replaceAll(entries: AgentProfile): void {
    this.emit(applyChange(this.entries, agentProfileChangeBetween(this.storedEntries, entries)))
  }

  /** Sets these entries as one change, so a hand-written skill's files turn off or on together. */
  setEntry(...entries: AgentProfileEntry[]): void {
    this.emit(applyChange(this.entries, { set: agentProfileFrom(entries), reset: [] }))
  }

  /** Removes these keys as one change, so a hand-written skill's files leave together. */
  removeKey(...keys: AgentProfileKey[]): void {
    this.emit(applyChange(this.entries, { set: {}, reset: keys }))
  }

  /**
   * Shows the record of another account (null: signed out). A first sign-in
   * starts from a copy of the anonymous record; an account's record is never
   * copied into the anonymous one.
   */
  setAccount(accountKey: string | null): void {
    const next = accountKey ?? ANONYMOUS_AGENT_PROFILE
    if (next === this.accountKey) return
    let entries = readStoredEntries(this.storage, next)
    if (!entries) {
      entries = readStoredEntries(this.storage, ANONYMOUS_AGENT_PROFILE) ?? {}
      writeStoredEntries(this.storage, next, entries)
    }
    this.accountKey = next
    applyChange(this.entries, agentProfileChangeBetween(this.storedEntries, entries))
  }

  /** Sign-out: this account's local record leaves this client. */
  removeProfile(accountKey: string): void {
    if (accountKey === ANONYMOUS_AGENT_PROFILE) return
    if (accountKey === this.accountKey) this.setAccount(null)
    removeStoredEntries(this.storage, accountKey)
  }

  private emit(change: AgentProfileChange): void {
    this.persist()
    if (isEmptyChange(change)) return
    for (const listener of this.listeners) listener(change)
  }

  private persist(): void {
    writeStoredEntries(this.storage, this.accountKey, this.storedEntries)
  }
}

export const agentProfileLocalStore = new AgentProfileLocalStore()
