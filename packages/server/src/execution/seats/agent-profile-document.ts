import {
  AGENT_PROFILE_MAX_TOTAL_BYTES,
  agentProfileByteLength,
  agentProfileEntrySchema,
  agentProfileKeyOf,
  agentProfileKeySchema,
  isRetiredAgentProfileEntry,
  type AgentProfile,
  type AgentProfileDocumentPatch,
  type HostAgentProfileDocument,
} from '@solus/contracts/agent-profile'
import { LOCAL_ORGANIZATION_ID } from '../../host/machine-kind'
import { createLogger } from '../../logger'
import { requireActingScope } from '../../vault/acting-scope'
import { readPersonalDocument, writePersonalDocument } from '../../data/personal-documents/personal-documents'

const log = createLogger('seats', 'agent-profile-document.ts')

/**
 * A signed-out person's agent profile list on this host (ADR 0007 decision 6,
 * docs/plans/personal-settings-source.md): the source of what their Agent
 * profile page shows while signed out, kept in `personal_documents`. Keeping it
 * applies nothing; a copy to a host's seats (`agentProfileApply`) sends it.
 * Signed in, the account is the source and a host pulls it (`agent-profile.ts`).
 */

/** A host is the home of each person who uses it (docs/plans/person-state.md §3). */
const SCOPE = LOCAL_ORGANIZATION_ID

function actingPersonKey(): string {
  const { personKey } = requireActingScope("a person's agent profile")
  if (personKey === null) throw new Error('Only a person has an agent profile.')
  return personKey
}

/** The entries a reader kept, and the keys of the ones it left out. */
interface KnownEntries {
  entries: AgentProfile
  ignored: string[]
}

/**
 * The entries this host can read, one at a time: an entry whose key or kind
 * this version does not know, or a retired entry, is left out and named, so a
 * newer client never makes a call fail.
 */
function knownEntries(sent: AgentProfile): KnownEntries {
  const entries: AgentProfile = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(sent)) {
    const entry = agentProfileEntrySchema.safeParse(value)
    if (agentProfileKeySchema.safeParse(key).success && entry.success && agentProfileKeyOf(entry.data) === key && !isRetiredAgentProfileEntry(entry.data)) entries[key] = entry.data
    else ignored.push(key)
  }
  return { entries, ignored }
}

async function documentOf(personKey: string): Promise<HostAgentProfileDocument> {
  const row = await readPersonalDocument(SCOPE, personKey, 'agent-profile')
  if (!row) return { entries: {}, updatedAt: null }
  try {
    return { entries: knownEntries(JSON.parse(row.content)).entries, updatedAt: row.updatedAt }
  } catch {
    return { entries: {}, updatedAt: row.updatedAt }
  }
}

/** `agentProfileDocumentGet`: the copy of the person the current call acts for. */
export function actingAgentProfileDocument(): Promise<HostAgentProfileDocument> {
  return documentOf(actingPersonKey())
}

/** `agentProfileDocumentPatch`: changes the copy of the person the current call acts for. */
export async function patchActingAgentProfileDocument(change: AgentProfileDocumentPatch | undefined): Promise<HostAgentProfileDocument> {
  const personKey = actingPersonKey()
  const current = await documentOf(personKey)
  const { entries: set, ignored } = knownEntries(change?.set ?? {})
  const entries = { ...current.entries }
  for (const key of change?.reset ?? []) delete entries[key]
  Object.assign(entries, set)
  if (agentProfileByteLength(entries) > AGENT_PROFILE_MAX_TOTAL_BYTES) throw new Error('Your agent profile is larger than a host keeps. Remove an entry first.')
  // Only keys are logged: the entries are the person's.
  if (ignored.length) log.info('agent_profile_document_entries_ignored', { keys: ignored.sort() })
  const updatedAt = Date.now()
  await writePersonalDocument(SCOPE, { personKey, kind: 'agent-profile', content: JSON.stringify(entries), source: 'host', accountRevision: null, updatedAt })
  return { entries, updatedAt }
}
