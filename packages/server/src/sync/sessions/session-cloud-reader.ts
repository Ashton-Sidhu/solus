import { sql } from 'drizzle-orm'
import type { Principal } from '../../admission/principal'
import { authorize } from '../../admission/access-policy'
import type { Db } from '../../db/database'
import { session } from '../../data/sessions/schema'
import { readSessionRepository, type SessionRepositoryRow } from '../../data/sessions/session-repositories'
import type { ShareManager } from '../../sharing/share-manager'
import type { SessionRemoteProvider } from './session-remote-provider'
import { sessionManifestSchema, type SessionManifest } from './session-manifest'
import { formatSessionCloudScope } from '@solus/contracts/session-repositories'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionPreviewResult } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import { projectSessionHistory } from '../../data/sessions/result-projection'
import { messageSchema } from '../../data/sessions/transcript-reads'

const MANIFEST_BYTES = 1024 * 1024
const ROW_BYTES = 4 * 1024 * 1024
const PATCH_BYTES = 2 * 1024 * 1024

/** Reads only projected rows and patches at the head the API has accepted. */
export class SessionCloudReader {
  constructor(private readonly db: Db, private readonly storage: SessionRemoteProvider | null, private readonly shares: ShareManager) {}

  private async repository(principal: Principal, sessionId: string): Promise<SessionRepositoryRow | null> {
    if (principal.kind !== 'org-member' && (principal.kind !== 'owner' || principal.via !== 'grant')) return null
    const personal = await readSessionRepository(this.db, formatSessionCloudScope('person', principal.userId), sessionId)
    if (personal?.owner_user_id === principal.userId) return personal
    if (principal.kind !== 'org-member') return null
    const published = await this.db.get(sql`SELECT session_id FROM ${session} WHERE session_id = ${sessionId} AND organization_id = ${principal.organizationId} AND publication = 'published'`)
    if (!published || await authorize(principal, 'read.transcript', { kind: 'session', id: sessionId }, { name: 'loadSessionPage', resources: this.shares }) !== null) return null
    return await readSessionRepository(this.db, formatSessionCloudScope('organization', principal.organizationId), sessionId) ?? null
  }

  private async manifest(principal: Principal, sessionId: string): Promise<{ row: SessionRepositoryRow; manifest: SessionManifest } | null> {
    const row = await this.repository(principal, sessionId)
    if (!row?.head || !this.storage || row.storage_scope !== this.storage.storageScope) return null
    const manifest = sessionManifestSchema.parse(JSON.parse(await this.storage.readFile(row.repository, row.head, 'manifest.json', MANIFEST_BYTES)))
    if (manifest.session.id !== sessionId) throw new Error('Session repository identity mismatch.')
    return { row, manifest }
  }

  async page(principal: Principal, sessionId: string, before?: string): Promise<SessionHistoryPage> {
    const source = await this.manifest(principal, sessionId)
    if (!source) return { messages: [], before: null, availability: 'not-available' }
    const index = before === undefined ? source.manifest.turns.length - 1 : Number(before)
    if (!Number.isSafeInteger(index) || index < 0 || index >= source.manifest.turns.length) return { messages: [], before: null, availability: 'not-available' }
    const turn = source.manifest.turns[index]!
    const next = index ? String(index - 1) : null
    if (!turn.hasRows) return { messages: [], before: next, availability: 'not-available', unavailableTurns: [index], turnIndex: index }
    return { messages: await this.rows(source.row, index), before: next, availability: 'available', turnIndex: index }
  }

  private async rows(row: SessionRepositoryRow, index: number): Promise<WireSessionLoadMessage[]> {
    const body = await this.storage!.readFile(row.repository, row.head!, `rows/${index}.jsonl`, ROW_BYTES)
    const messages: WireSessionLoadMessage[] = body.split('\n').filter(Boolean).map(line => messageSchema.parse(JSON.parse(line)))
    return messages.some(message => (message.role === 'tool' || message.role === 'tool_result') && message.content !== '')
      ? projectSessionHistory(messages) : messages
  }

  async preview(principal: Principal, sessionId: string): Promise<SessionPreviewResult> {
    const source = await this.manifest(principal, sessionId)
    if (!source) return { head: [], tail: [], totalMessages: 0 }
    const first = source.manifest.turns.findIndex(turn => turn.hasRows)
    const last = source.manifest.turns.findLastIndex(turn => turn.hasRows)
    if (first < 0 || last < 0) return { head: [], tail: [], totalMessages: 0 }
    const head = (await this.rows(source.row, first)).slice(0, 5)
    const tail = (await this.rows(source.row, last)).slice(-5)
    return { head, tail, totalMessages: source.manifest.turns.at(-1)?.rowCount ?? head.length }
  }

  async diff(principal: Principal, sessionId: string, turnIndex: number): Promise<SessionTurnDiff> {
    const source = await this.manifest(principal, sessionId)
    if (!source) return { status: 'not-available' }
    const turn = source.manifest.turns[turnIndex]
    if (!turn?.hasDiff) return { status: 'not-available' }
    try {
      return { status: 'available', patch: await this.storage!.readFile(source.row.repository, source.row.head!, `diff/${turnIndex}.patch`, PATCH_BYTES) }
    } catch (error) {
      if (error instanceof Error && error.message === 'SESSION_FILE_TOO_LARGE') return { status: 'too-large', filesChanged: turn.snapshots.reduce((sum, snapshot) => sum + snapshot.filesChanged, 0), additions: turn.snapshots.reduce((sum, snapshot) => sum + snapshot.additions, 0), deletions: turn.snapshots.reduce((sum, snapshot) => sum + snapshot.deletions, 0) }
      throw error
    }
  }
}
