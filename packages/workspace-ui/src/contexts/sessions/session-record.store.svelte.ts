import type { Message, SessionMeta } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { serverConnections } from '@solus/client-core/server-connections'
import type { SurfaceContext } from '../app/surface-context.svelte'
import { readSessionRecordPage, type SessionRecordPage } from './session-record-transcript'

/** One older page, oldest first. Its messages never change after they load. */
export interface SessionRecordOlderPage {
  key: number
  messages: Message[]
}

/** Turns a refresh may add to the newest page to meet the older pages again. */
const MAX_WIDEN_TURNS = 8

/** The newest cloud page, and the older pages the reader asked for. Coalesce
 * mirror batches, keep unchanged rows, and ignore reads after navigation.
 * Reconnect reloads the authoritative cloud copy. */
export class SessionRecordStore {
  meta = $state<SessionMeta | null>(null)
  /** The newest page. A refresh reconciles it in place. */
  messages = $state<Message[] | null>(null)
  /** Older pages above `messages`, oldest first. Each one is prepended once. */
  olderPages = $state<SessionRecordOlderPage[]>([])
  /** The cursor to the next older page; null when the session starts on screen. */
  olderCursor = $state<string | null>(null)
  loadingOlder = $state(false)
  olderError = $state<string | null>(null)
  loading = $state(true)
  error = $state<string | null>(null)
  transcriptError = $state<string | null>(null)
  private disposed = false
  private loadingNow = false
  private wanted = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Where the newest page starts once older pages hang above it. */
  private boundary: string | null = null
  private newestTurns = INITIAL_HISTORY_TURNS
  private pendingMessages: WireSessionLoadMessage[] | undefined
  private nextPageKey = 0
  /** A refresh and an older read never interleave: each reads the cursors the other sets. */
  private queue: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void
  private readonly stopStatus: () => void
  constructor(private readonly workspace: SurfaceContext, private readonly serverId: string, private readonly sessionId: string) {
    this.unsubscribe = serverConnections.eventsFor(serverId).subscribe('session.transcriptChanged', (event) => {
      if (event.sessionId !== sessionId || this.timer) return
      this.timer = setTimeout(() => { this.timer = null; void this.load() }, 200)
    })
    this.stopStatus = serverConnections.onStatusChange((id, status) => {
      if (id === serverId && status === 'connected') void this.load()
    })
    void this.load()
  }
  async load(): Promise<void> {
    if (this.disposed) return
    if (this.loadingNow) { this.wanted = true; return }
    this.loadingNow = true
    try {
      await this.exclusive(() => this.refresh())
    } catch (error) {
      if (!this.disposed) this.transcriptError = error instanceof Error ? error.message : String(error)
    } finally {
      this.loadingNow = false
      if (!this.disposed) {
        this.loading = false
        if (this.wanted) { this.wanted = false; void this.load() }
      }
    }
  }
  /** Read the next older page and put it above what is on screen. */
  async loadOlder(): Promise<void> {
    if (this.disposed || this.loadingOlder || this.olderCursor === null) return
    this.loadingOlder = true
    this.olderError = null
    try {
      await this.exclusive(async () => {
        const meta = this.meta
        const before = this.olderCursor
        if (!meta || before === null) return
        const page = await readSessionRecordPage(this.workspace, this.serverId, meta, { turnLimit: OLDER_HISTORY_TURNS, before, pendingMessages: this.pendingMessages })
        if (this.disposed || this.olderCursor !== before) return
        if (page.before === before) throw new Error('History paging made no progress.')
        if (this.olderPages.length === 0) this.boundary = before
        this.olderPages.unshift({ key: this.nextPageKey++, messages: page.messages })
        this.olderCursor = page.before
        this.pendingMessages = page.pendingMessages
      })
    } catch (error) {
      if (!this.disposed) this.olderError = error instanceof Error ? error.message : String(error)
    } finally {
      if (!this.disposed) this.loadingOlder = false
    }
  }
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.stopStatus()
    if (this.timer) clearTimeout(this.timer)
  }

  private async refresh(): Promise<void> {
    const meta = await readSessionMeta(this.serverId, this.sessionId)
    if (this.disposed) return
    this.meta = meta
    if (!meta) { this.error = 'The workspace has no record of this session.'; return }
    this.error = null
    const page = await this.readNewest(meta)
    if (this.disposed) return
    this.transcriptError = null
    if (this.boundary === null) {
      this.olderCursor = page.before
      this.pendingMessages = page.pendingMessages
    }
    const messages = page.messages
    if (!this.messages) this.messages = messages
    else {
      for (let index = 0; index < messages.length; index++) {
        if (JSON.stringify(this.messages[index]) !== JSON.stringify(messages[index])) this.messages[index] = messages[index]!
      }
      if (this.messages.length > messages.length) this.messages.splice(messages.length)
    }
  }

  /**
   * The newest page. With older pages above it, new turns would push its start
   * past them and leave a gap, so it widens one turn at a time until it starts
   * where they end again. When it cannot, the older pages are let go: a
   * shorter history is honest, a gap is not.
   */
  private async readNewest(meta: SessionMeta): Promise<SessionRecordPage> {
    let page = await readSessionRecordPage(this.workspace, this.serverId, meta, { turnLimit: this.newestTurns })
    if (this.boundary === null) return page
    for (let widened = 0; page.before !== this.boundary && page.before !== null && widened < MAX_WIDEN_TURNS; widened++) {
      this.newestTurns++
      page = await readSessionRecordPage(this.workspace, this.serverId, meta, { turnLimit: this.newestTurns })
    }
    if (page.before !== this.boundary) {
      this.olderPages.splice(0)
      this.boundary = null
    }
    return page
  }

  private exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }
}
