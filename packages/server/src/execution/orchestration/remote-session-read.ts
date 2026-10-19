import type { SolusApiClient } from '@solus/contracts/solus-api/client'
import type { WorkspaceSession, WorkspaceTranscriptPart } from '@solus/contracts/solus-api/schemas'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionMeta } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import type { RemoteHost } from './remote-hosts'

const log = createLogger('sessions', 'remote-session-read.ts')

/** A session that is not on this host, and how to read its messages. */
export interface RemoteSession {
  /** Where it was found: a host's name, or an organization's Solus API. */
  source: string
  meta: SessionMeta
  /** The last `limit` messages; without a limit, the whole transcript. */
  load(limit?: number): Promise<SessionLoadMessage[]>
}

/** An organization's Solus API, as the person a turn acts for. */
export interface OrganizationApi {
  organizationId: string
  client: SolusApiClient
}

/** The API sends at most 200 parts a page; a longer transcript is cut at this many pages. */
const TRANSCRIPT_PAGE_LIMIT = 50

/**
 * Finds a session on the person's other hosts, then on their organizations'
 * Solus APIs. All are asked at once. A host wins over an API: the host has the
 * provider transcript with its tools, and the API has only the stored text.
 */
export async function findRemoteSession(sessionId: string, hosts: RemoteHost[], apis: OrganizationApi[]): Promise<RemoteSession | null> {
  const onHosts = firstFound(hosts.map((host) => sessionOnHost(host, sessionId)))
  const onApis = firstFound(apis.map((api) => sessionOnApi(api, sessionId)))
  return (await onHosts) ?? (await onApis)
}

/** The first lookup that finds the session; null when none does. */
async function firstFound<T>(lookups: Promise<T | null>[]): Promise<T | null> {
  if (!lookups.length) return null
  return Promise.any(lookups.map(async (lookup) => {
    const found = await lookup
    if (!found) throw new Error('not found')
    return found
  })).catch(() => null)
}

async function sessionOnHost(host: RemoteHost, sessionId: string): Promise<RemoteSession | null> {
  try {
    const meta = await host.call('the session lookup', () => host.api.getSessionInfo(sessionId))
    if (!meta) return null
    return {
      source: host.label,
      // The link opens the session on the host that holds it.
      meta: { ...meta, serverId: host.installationId },
      load: (limit) => host.call('the session transcript', () => host.api.loadSession(meta.sessionId, meta.projectPath || undefined, undefined, meta.provider, limit)),
    }
  } catch (error) {
    log.info('remote_session_lookup_failed', { host: host.label, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function sessionOnApi(api: OrganizationApi, sessionId: string): Promise<RemoteSession | null> {
  let session: WorkspaceSession
  try {
    session = await api.client.request('getSession', { id: sessionId })
  } catch (error) {
    log.info('remote_session_lookup_failed', { organizationId: api.organizationId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
  return {
    source: `the Solus API of organization ${api.organizationId}`,
    meta: apiSessionMeta(session),
    load: async (limit) => {
      const messages = await apiTranscript(api.client, session.id)
      return limit === undefined ? messages : messages.slice(-limit)
    },
  }
}

function apiSessionMeta(session: WorkspaceSession): SessionMeta {
  const meta: SessionMeta = {
    provider: session.provider,
    sessionId: session.id,
    slug: session.slug,
    firstMessage: null,
    customTitle: session.customTitle ?? session.title,
    lastTimestamp: session.updatedAt,
    size: session.size,
    cwd: session.cwd ?? session.projectPath,
    projectPath: session.projectPath,
    // The API knows only whether a turn runs.
    status: session.status === 'running' ? 'running' : 'idle',
  }
  if (session.organizationId) meta.organizationId = session.organizationId
  if (session.model) meta.model = session.model
  if (session.reasoningEffort) meta.reasoningEffort = session.reasoningEffort
  return meta
}

/** The stored text of a session, oldest first, with each message's parts joined. */
async function apiTranscript(client: SolusApiClient, sessionId: string): Promise<SessionLoadMessage[]> {
  const parts: WorkspaceTranscriptPart[] = []
  let cursor: string | undefined
  for (let page = 0; page < TRANSCRIPT_PAGE_LIMIT; page++) {
    const answer = await client.request('listSessionMessages', { id: sessionId, query: cursor ? { limit: 200, cursor } : { limit: 200 } })
    parts.push(...answer.items)
    if (!answer.nextCursor) break
    cursor = answer.nextCursor
  }
  const messages: SessionLoadMessage[] = []
  for (const part of parts) {
    const last = messages.at(-1)
    if (last && last.messageId === part.messageId && part.contentOffset > 0) {
      last.content += part.content
      continue
    }
    const message: SessionLoadMessage = { messageId: part.messageId, role: part.role, content: part.content, timestamp: Date.parse(part.timestamp) }
    if (part.toolName) message.toolName = part.toolName
    if (part.parentToolUseId) message.parentToolUseId = part.parentToolUseId
    messages.push(message)
  }
  return messages
}
