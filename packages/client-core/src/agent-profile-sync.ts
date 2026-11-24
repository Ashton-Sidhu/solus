import { z } from 'zod'
import {
  AGENT_PROFILE_MAX_TOTAL_BYTES,
  agentProfileEntriesWriteSchema,
  agentProfileByteLength,
  agentProfileSchema,
  agentProfileKeySchema,
  type AccountAgentProfileResponse,
  type AgentProfile,
  type AgentProfileKey,
} from '@solus/contracts/agent-profile'
import type { AccountAgentProfileResult, SolusAPI } from '@solus/contracts/host-api'
import type { AgentProfileCloudRequests } from './agent-profile-requests'
import { HomeHostDocument } from './home-host-document'
import {
  DocumentSync,
  type ClearOutcome as DocumentClearOutcome,
  type DocumentChange,
  type DocumentConflict,
  type DocumentSyncPorts,
  type DocumentSyncRequests,
  type DocumentSyncResult,
  type DocumentSyncStorage,
  type DocumentSyncStatus,
  type SyncedDocument,
  type SyncedDocumentContract,
} from './document-sync'

/**
 * Agent profile sync (plans/020-agent-profile.md §3): the document sync engine
 * bound to the agent profile entries. Each entry — one file, one registry
 * skill, one MCP server — is one key, so two clients that change different
 * entries merge, and one entry both changed is a conflict the person resolves.
 * The key set is open: a document holds whatever entries the person has.
 */

export type AgentProfileConflict = DocumentConflict<AgentProfile, AgentProfileKey>
export type AgentProfileSyncStatus = DocumentSyncStatus<AgentProfile, AgentProfileKey>
export type AgentProfileChange = DocumentChange<AgentProfile, AgentProfileKey>
export type AgentProfileClearOutcome = DocumentClearOutcome<AgentProfileKey>

export interface AgentProfileSyncPorts extends Omit<DocumentSyncPorts<AgentProfile, AgentProfileKey>, 'requests'> {
  /** The document calls; the connection calls of the same adapter are the integrations' (plans/020 §5.3). */
  requests: Pick<AgentProfileCloudRequests, 'accountAgentProfileGet' | 'accountAgentProfilePatch' | 'accountAgentProfileDelete'>
}

/** Every key the documents hold, once each. */
function entryKeys(...documents: AgentProfile[]): AgentProfileKey[] {
  const keys = new Set<string>()
  for (const document of documents) for (const key of Object.keys(document)) keys.add(key)
  // SAFETY: the entries schema admits only keys of the three prefixes, which is what `AgentProfileKey` names.
  return [...keys] as AgentProfileKey[]
}

const AGENT_PROFILE_CONTRACT: SyncedDocumentContract<AgentProfile, AgentProfileKey> = {
  storageKey: (accountKey) => `solus.agent-profile-sync.v1:${accountKey}`,
  // SAFETY: the key schema's pattern is the three prefixes of `AgentProfileKey`.
  keySchema: agentProfileKeySchema as z.ZodType<AgentProfileKey>,
  documentSchema: agentProfileSchema,
  keysOf: entryKeys,
  empty: () => ({}),
  byteLength: agentProfileByteLength,
  maxBytes: AGENT_PROFILE_MAX_TOTAL_BYTES,
  retriesExhaustedMessage: 'The synced agent profile kept changing. Sync tries again later.',
}

function syncedProfile(response: AccountAgentProfileResponse): SyncedDocument<AgentProfile> {
  return { generation: response.generation, revision: response.revision, document: response.entries, updatedAt: response.updatedAt }
}

function profileResult(result: AccountAgentProfileResult): DocumentSyncResult<AgentProfile> {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ok', document: syncedProfile(result.profile) }
    case 'conflict':
      return { kind: 'conflict', reason: result.reason === 'profile_conflict' ? 'revision' : 'generation', code: result.reason, current: syncedProfile(result.current) }
    default:
      return result
  }
}

/** The profile calls as the engine asks for them. */
export function agentProfileDocumentRequests(requests: AgentProfileSyncPorts['requests']): DocumentSyncRequests<AgentProfile, AgentProfileKey> {
  return {
    get: async () => profileResult(await requests.accountAgentProfileGet()),
    patch: async (request) => profileResult(await requests.accountAgentProfilePatch(request)),
    delete: async () => profileResult(await requests.accountAgentProfileDelete()),
  }
}

export class AgentProfileSync extends DocumentSync<AgentProfile, AgentProfileKey> {
  constructor(ports: AgentProfileSyncPorts) {
    super({ ...ports, requests: agentProfileDocumentRequests(ports.requests) }, AGENT_PROFILE_CONTRACT)
  }
}

/** The change that makes `current` equal to `desired`: entries to set, and keys to remove. */
export function agentProfileChangeBetween(current: AgentProfile, desired: AgentProfile): AgentProfileChange {
  const set: AgentProfile = {}
  for (const [key, entry] of Object.entries(desired)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(entry)) set[key] = entry
  }
  const reset = entryKeys(current).filter((key) => !(key in desired))
  return { set, reset }
}

export interface AgentProfileHomeHostPorts {
  /** The home host while signed out (`personalSettingsHomeId`); null signed in, or with none. */
  homeHostId(): string | null
  /** The calls of a ready host; null when it is not ready. */
  apiFor(hostId: string): Pick<SolusAPI, 'agentProfileDocumentGet' | 'agentProfileDocumentPatch'> | null
  /** The entries on screen. */
  document(): AgentProfile
  /** The home host's list replaces the one on screen. */
  adopt(entries: AgentProfile): void
  storage: DocumentSyncStorage
}

// SAFETY: the entries write schema admits only keys of the three prefixes, which is what `AgentProfileKey` names.
const pendingProfileSchema = agentProfileEntriesWriteSchema.transform((change) => ({ set: change.set, reset: change.reset as AgentProfileKey[] })) as z.ZodType<AgentProfileChange>

/**
 * The agent profile list of a signed-out person, whose source is their home host
 * (ADR 0007 decision 6): `HomeHostDocument` bound to the profile calls. Signed in,
 * the account is the source (`AgentProfileSync`).
 */
export function agentProfileHomeHost(ports: AgentProfileHomeHostPorts): HomeHostDocument<AgentProfile, AgentProfileKey> {
  return new HomeHostDocument<AgentProfile, AgentProfileKey>({
    homeHostId: () => ports.homeHostId(),
    callsFor: (hostId) => {
      const api = ports.apiFor(hostId)
      return api ? {
        get: async () => (await api.agentProfileDocumentGet()).entries,
        patch: async (change) => (await api.agentProfileDocumentPatch(change)).entries,
      } : null
    },
    document: () => ports.document(),
    adopt: (entries) => ports.adopt(entries),
    storage: ports.storage,
    storageKey: (hostId) => `solus.agent-profile.pending.v1:${hostId}`,
    pendingSchema: pendingProfileSchema,
  }, () => ({}))
}
