import { agentProfileSchema, type AgentProfile } from '@solus/contracts/agent-profile'
import type { AgentProfileChange } from '@solus/client-core/agent-profile-sync'

/**
 * The local copy of the agent profile, as it is stored on this client
 * (plans/020-agent-profile.md §3): one record per account, and one anonymous
 * record while signed out. The functions here keep the store thin: where a
 * record lives, how it reads, and how a change lands on the entries.
 */

export const ANONYMOUS_AGENT_PROFILE = 'anonymous'

export function agentProfileStorageKey(accountKey: string): string {
  return `solus.agent-profile.v1:${accountKey}`
}

/** The stored copy, or null when none. A copy that fails the schema reads as empty, never as an error. */
export function readStoredEntries(storage: Storage, accountKey: string): AgentProfile | null {
  const stored = storage.getItem(agentProfileStorageKey(accountKey))
  if (stored === null) return null
  try {
    const parsed = agentProfileSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writeStoredEntries(storage: Storage, accountKey: string, entries: AgentProfile): void {
  try {
    storage.setItem(agentProfileStorageKey(accountKey), JSON.stringify(entries))
  } catch {}
}

export function removeStoredEntries(storage: Storage, accountKey: string): void {
  try {
    storage.removeItem(agentProfileStorageKey(accountKey))
  } catch {}
}

/**
 * Lands a change on `entries` in place, one key at a time, so only the keys
 * that differ wake their readers. Answers what did change: an equal entry and
 * a key that was already absent are left out.
 */
export function applyChange(entries: AgentProfile, change: AgentProfileChange): AgentProfileChange {
  const applied: AgentProfileChange = { set: {}, reset: [] }
  for (const [key, entry] of Object.entries(change.set)) {
    if (JSON.stringify(entries[key]) === JSON.stringify(entry)) continue
    entries[key] = structuredClone(entry)
    applied.set[key] = structuredClone(entry)
  }
  for (const key of change.reset) {
    if (!(key in entries)) continue
    delete entries[key]
    applied.reset.push(key)
  }
  return applied
}

export function isEmptyChange(change: AgentProfileChange): boolean {
  return Object.keys(change.set).length === 0 && change.reset.length === 0
}
