import { readSessionCloudPage, readSessionTurnDiff } from '@solus/client-core/session-cloud-read'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { AgentId } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { TranscriptModel } from '../conversation/lib/transcript-model'
import type { CloudSessions } from './cloud-sessions'

/** A page of the cloud reader holds one whole turn. A turn with no rows in
 *  the cloud shows nothing, so a read goes on to older turns, this many at most. */
const MAX_TURNS_FOR_ROWS = 5

export type CloudTurnDiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; diff: SessionTurnDiff }
  | { kind: 'error'; message: string }

/** The head, next older turn, and prompt indexes of a cloud session read. */
interface CloudRead {
  readonly sessionId: string
  readonly provider: AgentId
  readonly head: string
  /** The turn the next older page holds. */
  nextTurnIndex: number
  /** Read turns that have no rows in the cloud. */
  unavailableTurns: number
  /** The turn each read prompt row starts, by its item id. */
  readonly turnOfPrompt: Map<string, number>
}

const IDLE: CloudTurnDiffState = { kind: 'idle' }

/**
 * A session's read-only copy from Solus Cloud on the phone
 * (docs/plans/portable-sessions-cloud.md, Phase 5B). It reads the history the
 * Solus API keeps at the head it accepted, one turn for each page, newest
 * first, into a transcript model that the thread screen draws as any other.
 * A model it made is a copy: the conversation that shows it reads its older
 * turns here, and a host's history replaces it. It also keeps the diff of each
 * turn the person opens. Everything goes when the Solus API connection changes.
 */
export class CloudHistory {
  readonly changes = new Listeners()
  private readonly copies = new WeakMap<TranscriptModel, CloudRead>()
  private readonly diffs = new Map<string, CloudTurnDiffState>()
  private connectionId: string | null

  constructor(private readonly cloud: Pick<CloudSessions, 'connection' | 'recordFor' | 'changes'>) {
    this.connectionId = cloud.connection?.hostId ?? null
    // Another account or organization: its diffs are not this one's.
    cloud.changes.subscribe(() => {
      const connectionId = cloud.connection?.hostId ?? null
      if (connectionId === this.connectionId) return
      this.connectionId = connectionId
      this.diffs.clear()
      this.changes.notify()
    })
  }

  /** The newest turns with rows, as a fresh model. Throws when the cloud cannot be read. */
  async read(sessionId: string, provider: AgentId): Promise<TranscriptModel> {
    const record = this.cloud.recordFor(sessionId)
    if (!record?.head || record.syncedTurn <= 0) throw new Error('Solus Cloud has no turn of this session.')
    const copy: CloudRead = { sessionId, provider, head: record.head, nextTurnIndex: record.syncedTurn - 1, unavailableTurns: 0, turnOfPrompt: new Map() }
    const model = new TranscriptModel(sessionId)
    // The first page has no cursor; the model takes the page's own after it.
    model.olderCursor = ''
    this.copies.set(model, copy)
    await this.readTurns(model, copy)
    return model
  }

  /** The model is a copy this owner read. */
  isCopy(model: TranscriptModel): boolean {
    return this.copies.has(model)
  }

  /** The head a copy was read at, and its turns with no rows; null for a model that is not a copy. */
  copyOf(model: TranscriptModel): { head: string; unavailableTurns: number } | null {
    const copy = this.copies.get(model)
    return copy ? { head: copy.head, unavailableTurns: copy.unavailableTurns } : null
  }

  /** The turn that a prompt row of a copy starts; null for any other row or model. */
  turnOf(model: TranscriptModel, promptId: string): number | null {
    return this.copies.get(model)?.turnOfPrompt.get(promptId) ?? null
  }

  /** The older turns of a copy go before what it shows. */
  async readOlder(model: TranscriptModel): Promise<void> {
    const copy = this.copies.get(model)
    if (copy && model.olderCursor) await this.readTurns(model, copy)
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

  /** Reads turns from the copy's next older one until one has rows, the first turn is read, or the cap. */
  private async readTurns(model: TranscriptModel, copy: CloudRead): Promise<void> {
    const connection = this.cloud.connection
    if (!connection) throw new Error('Sign in to Solus Cloud to read this session.')
    for (let read = 0; read < MAX_TURNS_FOR_ROWS && model.olderCursor !== null; read += 1) {
      const turnIndex = copy.nextTurnIndex
      let page: SessionHistoryPage
      try {
        page = await readSessionCloudPage(connection.api, { sessionId: copy.sessionId, provider: copy.provider, before: model.olderCursor || undefined })
      } catch (error) {
        // Turns read before the failure stay; the reader can scroll up again.
        if (read === 0) throw error
        return
      }
      const shown = model.order.length
      model.prependHistory(page)
      copy.nextTurnIndex = turnIndex - 1
      if (page.availability === 'not-available' && page.messages.length === 0) copy.unavailableTurns += 1
      const added = model.order.slice(0, model.order.length - shown)
      for (const id of added) if (model.items.get(id)?.kind === 'user') copy.turnOfPrompt.set(id, turnIndex)
      if (added.length > 0) return
    }
  }

  private setDiff(key: string, state: CloudTurnDiffState): void {
    this.diffs.set(key, state)
    this.changes.notify()
  }
}

function diffKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}\u0000${turnIndex}`
}
