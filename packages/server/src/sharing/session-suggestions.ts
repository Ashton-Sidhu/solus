import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  SUGGESTIONS_WAITING_MAX,
  sessionSuggestRequestSchema,
  type SessionSuggestion,
  type SessionSuggestRequest,
  type SuggestionAttachment,
} from '@solus/contracts/session-suggestions'
import { attachmentsRoot, uploadFolderName } from '../data/assets/attachment-store'
import { createLogger } from '../logger'

const log = createLogger('main', 'session-suggestions')

/** Decided suggestions a session keeps, so their authors can still see what became of them. */
const DECIDED_KEPT = 20

interface StoredSuggestion extends Omit<SessionSuggestion, 'isMine'> {
  /** The author's person key (`ownerKeyOf`): a guest's is its guest id. */
  authorKey: string
  /** Whether a link guest wrote it: closing that link ends it. */
  byGuest: boolean
}

export interface SuggestionAuthor {
  key: string
  name: string
  isGuest: boolean
}

export class SuggestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestionError'
  }
}

export interface SessionSuggestionsDeps {
  /** A session's suggestions changed: its watchers read them again. */
  onChanged(sessionId: string): void
  attachmentsDir?: string
  now?: () => number
}

/**
 * The suggestions of every session on this host (docs/plans/custom-roles.md §7).
 * It holds them in memory: a waiting suggestion does not survive a restart of the
 * host, as a draft in a composer does not. It decides nothing about access; the
 * gate already asked for `drive.propose` or `drive.prompt`. Sending one is the
 * caller's: this store marks it sent and gives back its text and files once.
 */
export class SessionSuggestions {
  private readonly bySession = new Map<string, StoredSuggestion[]>()

  constructor(private readonly deps: SessionSuggestionsDeps) {}

  /** All of a session's suggestions to someone who may prompt it; a person's own to anyone else. */
  list(sessionId: string, viewer: { key: string | null; seesAll: boolean }): SessionSuggestion[] {
    return (this.bySession.get(sessionId) ?? [])
      .filter((stored) => viewer.seesAll || stored.authorKey === viewer.key)
      .map((stored) => this.view(stored, viewer.key))
  }

  async suggest(sessionId: string, author: SuggestionAuthor, input: SessionSuggestRequest): Promise<SessionSuggestion> {
    const request = sessionSuggestRequestSchema.parse(input)
    const all = this.bySession.get(sessionId) ?? []
    const waiting = all.filter((stored) => stored.state === 'waiting' && stored.authorKey === author.key).length
    if (waiting >= SUGGESTIONS_WAITING_MAX) throw new SuggestionError(`You have ${SUGGESTIONS_WAITING_MAX} suggestions waiting. Wait for one to be sent or dismissed.`)
    for (const attachment of request.attachments) this.assertUploadedHere(sessionId, attachment)
    const stored: StoredSuggestion = {
      id: randomUUID(),
      sessionId,
      authorName: author.name,
      authorKey: author.key,
      byGuest: author.isGuest,
      text: request.text,
      attachments: request.attachments,
      state: 'waiting',
      createdAt: this.now(),
    }
    all.push(stored)
    this.bySession.set(sessionId, all)
    log.info('suggestion_made', { sessionId, suggestionId: stored.id, attachments: stored.attachments.length, byGuest: stored.byGuest })
    this.deps.onChanged(sessionId)
    return this.view(stored, author.key)
  }

  /** Its author takes back one that still waits. */
  async withdraw(sessionId: string, suggestionId: string, authorKey: string | null): Promise<boolean> {
    const stored = this.waiting(sessionId, suggestionId)
    if (!stored || stored.authorKey !== authorKey) return false
    await this.close(stored, 'withdrawn')
    return true
  }

  async dismiss(sessionId: string, suggestionId: string, deciderName: string): Promise<boolean> {
    const stored = this.waiting(sessionId, suggestionId)
    if (!stored) return false
    stored.decidedByName = deciderName
    await this.close(stored, 'dismissed')
    return true
  }

  /**
   * Marks one waiting suggestion sent and gives back what to send, once: a second
   * Send of the same suggestion, from another client, gets null.
   */
  take(sessionId: string, suggestionId: string, senderName: string): Pick<StoredSuggestion, 'text' | 'attachments' | 'authorName'> | null {
    const stored = this.waiting(sessionId, suggestionId)
    if (!stored) return null
    stored.state = 'sent'
    stored.decidedByName = senderName
    this.trim(sessionId)
    log.info('suggestion_sent', { sessionId, suggestionId })
    this.deps.onChanged(sessionId)
    return { text: stored.text, attachments: stored.attachments, authorName: stored.authorName }
  }

  /** A send that failed after `take`: the suggestion waits again, so nobody loses it. */
  restore(sessionId: string, suggestionId: string): void {
    const stored = this.bySession.get(sessionId)?.find((candidate) => candidate.id === suggestionId)
    if (!stored || stored.state !== 'sent') return
    stored.state = 'waiting'
    delete stored.decidedByName
    this.deps.onChanged(sessionId)
  }

  /** The session's link was removed or replaced: what its guests suggested and nobody sent ends with it. */
  async endGuestSuggestions(sessionId: string): Promise<void> {
    const ended = (this.bySession.get(sessionId) ?? []).filter((stored) => stored.byGuest && stored.state === 'waiting')
    for (const stored of ended) await this.close(stored, 'dismissed', false)
    if (ended.length) this.deps.onChanged(sessionId)
  }

  private waiting(sessionId: string, suggestionId: string): StoredSuggestion | undefined {
    return this.bySession.get(sessionId)?.find((stored) => stored.id === suggestionId && stored.state === 'waiting')
  }

  /** A suggestion that will never be sent: its files go too. */
  private async close(stored: StoredSuggestion, state: 'dismissed' | 'withdrawn', announce = true): Promise<void> {
    stored.state = state
    for (const attachment of stored.attachments) {
      try {
        await rm(attachment.hostPath, { force: true })
      } catch (error) {
        log.warn('suggestion_file_remove_failed', { sessionId: stored.sessionId, suggestionId: stored.id, error: String(error) })
      }
    }
    this.trim(stored.sessionId)
    log.info('suggestion_closed', { sessionId: stored.sessionId, suggestionId: stored.id, state })
    if (announce) this.deps.onChanged(stored.sessionId)
  }

  /** Waiting ones are all kept; of the decided ones, the latest few. */
  private trim(sessionId: string): void {
    const all = this.bySession.get(sessionId)
    if (!all) return
    const decided = all.filter((stored) => stored.state !== 'waiting')
    const dropped = new Set(decided.slice(0, Math.max(0, decided.length - DECIDED_KEPT)))
    if (dropped.size) this.bySession.set(sessionId, all.filter((stored) => !dropped.has(stored)))
  }

  /**
   * A suggestion names only files uploaded to its own session: a path from a
   * client is untrusted, and a sent suggestion hands its files to the agent.
   */
  private assertUploadedHere(sessionId: string, attachment: SuggestionAttachment): void {
    const folder = join(this.deps.attachmentsDir ?? attachmentsRoot(), uploadFolderName(sessionId))
    const inside = relative(folder, resolve(attachment.hostPath))
    if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`) || resolve(folder, inside) !== resolve(attachment.hostPath)) {
      throw new SuggestionError('A suggestion can attach only files uploaded to this session.')
    }
  }

  private view(stored: StoredSuggestion, viewerKey: string | null): SessionSuggestion {
    const view: SessionSuggestion = {
      id: stored.id,
      sessionId: stored.sessionId,
      authorName: stored.authorName,
      isMine: stored.authorKey === viewerKey,
      text: stored.text,
      attachments: [...stored.attachments],
      state: stored.state,
      createdAt: stored.createdAt,
    }
    if (stored.decidedByName) view.decidedByName = stored.decidedByName
    return view
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
