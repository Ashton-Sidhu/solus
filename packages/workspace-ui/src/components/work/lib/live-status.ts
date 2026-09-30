import type { WorkLiveLock } from '@solus/contracts/work-live'
import type { LiveConnection } from '../../../contexts/works/work-live-doc.svelte'

export interface LiveStatusInput {
  connection: LiveConnection
  mode: 'edit' | 'read'
  readReason: 'role' | 'schema' | null
  lock: WorkLiveLock | null
  unsent: number
}

export interface LiveStatus {
  label: string
  /** `ok`: every edit is on the host. `busy`: edits are on their way. `warn`: they wait. */
  tone: 'ok' | 'busy' | 'warn'
}

function unsentWords(unsent: number): string {
  return `${unsent} unsent ${unsent === 1 ? 'edit' : 'edits'}`
}

/**
 * The header's one line about a live work (docs/plans/work-review-and-live-editing.md,
 * phase 3c). A work with edits the host has not confirmed never says it is saved.
 */
export function liveStatus(input: LiveStatusInput): LiveStatus {
  if (input.connection === 'offline') return { label: input.unsent > 0 ? `Offline · ${unsentWords(input.unsent)}` : 'Offline', tone: 'warn' }
  if (input.connection === 'connecting') return { label: input.unsent > 0 ? `Reconnecting · ${unsentWords(input.unsent)}` : 'Connecting…', tone: 'warn' }
  if (input.lock) return { label: input.lock.by?.kind === 'agent' ? 'Agent is editing' : 'Updating…', tone: 'busy' }
  if (input.mode === 'read') return { label: input.readReason === 'schema' ? 'Read-only · update Solus to edit' : 'Read-only', tone: 'ok' }
  if (input.unsent > 0) return { label: 'Saving…', tone: 'busy' }
  return { label: 'Live', tone: 'ok' }
}
