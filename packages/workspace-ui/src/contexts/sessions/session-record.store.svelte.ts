import type { Message, SessionMeta } from '@solus/contracts/types'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { serverConnections } from '@solus/client-core/server-connections'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { loadSessionRecordTranscript } from './session-record-transcript'

/** One cloud page. Coalesce mirror batches, keep unchanged rows, and ignore reads
 * after navigation. Reconnect reloads the authoritative cloud copy. */
export class SessionRecordStore {
  meta = $state<SessionMeta | null>(null)
  messages = $state<Message[] | null>(null)
  loading = $state(true)
  error = $state<string | null>(null)
  transcriptError = $state<string | null>(null)
  private disposed = false
  private loadingNow = false
  private wanted = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly unsubscribe: () => void
  private readonly stopStatus: () => void
  constructor(private readonly workspace: WorkspaceContext, private readonly serverId: string, private readonly sessionId: string) {
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
      const meta = await readSessionMeta(this.serverId, this.sessionId)
      if (this.disposed) return
      this.meta = meta
      if (!meta) { this.error = 'The workspace has no record of this session.'; return }
      this.error = null
      const messages = await loadSessionRecordTranscript(this.workspace, this.serverId, meta)
      if (this.disposed) return
      this.transcriptError = null
      if (!this.messages) this.messages = messages
      else {
        for (let index = 0; index < messages.length; index++) {
          if (JSON.stringify(this.messages[index]) !== JSON.stringify(messages[index])) this.messages[index] = messages[index]!
        }
        if (this.messages.length > messages.length) this.messages.splice(messages.length)
      }
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
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.stopStatus()
    if (this.timer) clearTimeout(this.timer)
  }
}
