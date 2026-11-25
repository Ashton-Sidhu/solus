import { sessionFeedHistoryOptions } from '@solus/contracts/session-feed-item'
import { readSessionCloudPage, readSessionTurnDiff } from '@solus/client-core/session-cloud-read'
import type { SessionTurnDiffRef } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { AgentId } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { TranscriptModel } from '../conversation/lib/transcript-model'
import type { HostConnection } from '../hosts/host-connections'
import type { CloudSessions } from './cloud-sessions'

export type CloudTurnDiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; diff: SessionTurnDiff }
  | { kind: 'error'; message: string }

/** What a cloud session read keeps beside its rows. */
interface CloudRead {
  readonly sessionId: string
  readonly provider: AgentId
  /** The turn diffs that the pages read so far named. */
  readonly turnDiffs: SessionTurnDiffRef[]
  /** The turn whose diff each read prompt row has, by its item id. */
  readonly turnOfPrompt: Map<string, number>
}

const IDLE: CloudTurnDiffState = { kind: 'idle' }

/**
 * A session's read-only copy from Solus Cloud on the phone
 * (docs/plans/portable-sessions-cloud.md, Phase 5B). It reads the rows that
 * the Solus API keeps in the transcript mirror, some turns for each page,
 * newest first, into a transcript model that the thread screen draws as any
 * other. It asks and takes what the mirror answers: a session with no rows
 * there is a copy with no rows. A model it made is a copy: the conversation
 * that shows it reads its older turns here, and a host's history replaces it.
 * It also keeps the diff of each turn the person opens, and whether the mirror
 * got rows after a copy was read. Everything goes when the Solus API
 * connection changes.
 */
export class CloudHistory {
  readonly changes = new Listeners()
  private readonly copies = new WeakMap<TranscriptModel, CloudRead>()
  private readonly diffs = new Map<string, CloudTurnDiffState>()
  /** Each session read on this connection: true when the mirror got rows after its last read began. */
  private readonly newerRows = new Map<string, boolean>()
  private followed: HostConnection | null = null
  private stopFollowing: (() => void) | null = null

  constructor(private readonly cloud: Pick<CloudSessions, 'connection' | 'changes'>) {
    this.follow()
    cloud.changes.subscribe(() => { this.follow() })
  }

  /** The newest turns in the mirror, as a fresh model. Throws when the cloud cannot be read. */
  async read(sessionId: string, provider: AgentId): Promise<TranscriptModel> {
    this.follow()
    const copy: CloudRead = { sessionId, provider, turnDiffs: [], turnOfPrompt: new Map() }
    const model = new TranscriptModel(sessionId)
    this.copies.set(model, copy)
    // Before the request: rows that arrive while it travels can be absent from its answer.
    this.setNewerRows(sessionId, false)
    await this.readPage(model, copy)
    return model
  }

  /** The model is a copy this owner read. */
  isCopy(model: TranscriptModel): boolean {
    return this.copies.has(model)
  }

  /** The mirror got rows or a turn diff of the session after its copy was read. */
  hasNewerRows = (sessionId: string): boolean => this.newerRows.get(sessionId) === true

  /** The turn whose diff the mirror holds for a prompt row of a copy; null for any other row or model. */
  turnOf(model: TranscriptModel, promptId: string): number | null {
    return this.copies.get(model)?.turnOfPrompt.get(promptId) ?? null
  }

  /** The older turns of a copy go before what it shows. */
  async readOlder(model: TranscriptModel, throughEntryId?: string): Promise<void> {
    const copy = this.copies.get(model)
    if (copy && model.olderCursor) await this.readPage(model, copy, throughEntryId)
  }

  diffOf = (sessionId: string, turnIndex: number): CloudTurnDiffState => this.diffs.get(diffKey(sessionId, turnIndex)) ?? IDLE

  /** Reads one turn's diff. A turn's diff never changes, so an answer is kept. */
  async loadDiff(sessionId: string, turnIndex: number): Promise<void> {
    const key = diffKey(sessionId, turnIndex)
    const state = this.diffs.get(key)
    if (state?.kind === 'loading' || state?.kind === 'loaded') return
    const connection = this.cloud.connection
    if (!connection) {
      this.setDiff(key, { kind: 'error', message: 'Sign in to Solus Cloud to see the changes of this turn.' })
      return
    }
    this.setDiff(key, { kind: 'loading' })
    try {
      const diff = await readSessionTurnDiff(connection.api, sessionId, turnIndex)
      if (this.cloud.connection === connection) this.setDiff(key, { kind: 'loaded', diff })
    } catch (error) {
      if (this.cloud.connection === connection) this.setDiff(key, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Hears the Solus API connection that the copies are read through. Another
   * account or organization: its diffs and its news of rows are not this one's.
   */
  private follow(): void {
    const connection = this.cloud.connection
    if (connection === this.followed) return
    this.stopFollowing?.()
    this.followed = connection
    this.stopFollowing = connection?.events.subscribe('session.transcriptChanged', ({ sessionId }) => {
      // Only a session read here has a copy that can be behind.
      if (this.newerRows.get(sessionId) === false) this.setNewerRows(sessionId, true)
    }) ?? null
    this.diffs.clear()
    this.newerRows.clear()
    this.changes.notify()
  }

  /** Reads the page before what the copy shows, and joins the turn diffs it names to their prompt rows. */
  private async readPage(model: TranscriptModel, copy: CloudRead, throughEntryId?: string): Promise<void> {
    const connection = this.cloud.connection
    if (!connection) throw new Error('Sign in to Solus Cloud to read this session.')
    const page = await readSessionCloudPage(connection.api, { ...sessionFeedHistoryOptions, sessionId: copy.sessionId, provider: copy.provider, before: model.olderCursor || undefined, ...(throughEntryId && { throughEntryId }) })
    model.prependHistory(page)
    if (page.turnDiffs) copy.turnDiffs.push(...page.turnDiffs)
    if (copy.turnDiffs.length > 0) joinTurnDiffs(model, copy)
  }

  private setNewerRows(sessionId: string, hasNewerRows: boolean): void {
    if (this.newerRows.get(sessionId) === hasNewerRows) return
    this.newerRows.set(sessionId, hasNewerRows)
    this.changes.notify()
  }

  private setDiff(key: string, state: CloudTurnDiffState): void {
    this.diffs.set(key, state)
    this.changes.notify()
  }
}

/**
 * Gives each turn diff to the prompt row of its turn: the last prompt that
 * started at or before the time the turn ended. All the diffs are joined again
 * on each page, because an older page can bring the prompt of a diff that a
 * newer page named. When a prompt on screen has more than one turn (a session
 * report started the next one), it keeps the newest.
 */
function joinTurnDiffs(model: TranscriptModel, copy: CloudRead): void {
  const prompts: Array<{ id: string; startedAt: number }> = []
  for (const id of model.order) {
    const item = model.items.get(id)
    if (item?.kind === 'user' && item.timestamp !== undefined) prompts.push({ id, startedAt: item.timestamp })
  }
  copy.turnOfPrompt.clear()
  for (const diff of copy.turnDiffs) {
    let promptId: string | null = null
    for (const prompt of prompts) {
      if (prompt.startedAt > diff.endedAt) break
      promptId = prompt.id
    }
    if (promptId !== null && (copy.turnOfPrompt.get(promptId) ?? -1) < diff.turnIndex) copy.turnOfPrompt.set(promptId, diff.turnIndex)
  }
}

function diffKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}\u0000${turnIndex}`
}
