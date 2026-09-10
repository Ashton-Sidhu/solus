import type { WorkExternalLink } from '@solus/contracts/docs'
import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type { ExternalCommentCommand, WorkExternalComments } from '@solus/contracts/work-comments'
import { serverConnections } from '@solus/client-core/server-connections'
import { PresenceWatch } from '../../lib/presence-watch'

export class ExternalCommentsStore {
  readonly states = new SvelteMap<string, WorkExternalComments>()
  readonly errors = new SvelteMap<string, string>()
  readonly busy = new SvelteMap<string, boolean>()
  private tokens = new Map<string, number>()
  private watches = new PresenceWatch()
  constructor(private api: (workId: string) => HostApi, private link: (workId: string) => WorkExternalLink | undefined) {}

  stateFor(workId: string): WorkExternalComments | undefined {
    const state = this.states.get(workId)
    const link = this.link(workId)
    return state && link && state.provider === link.provider && state.documentId === link.externalId && state.externalKey === link.externalKey ? state : undefined
  }

  async load(workId: string, refresh = false): Promise<void> {
    const token = (this.tokens.get(workId) ?? 0) + 1
    this.tokens.set(workId, token)
    try {
      const api = this.api(workId)
      const result = refresh ? await api.refreshWorkExternalComments(workId) : await api.readWorkExternalComments(workId)
      if (this.tokens.get(workId) !== token) return
      this.apply(workId, result)
      this.errors.delete(workId)
    } catch (error) {
      if (this.tokens.get(workId) === token) this.errors.set(workId, externalCommentError(error instanceof Error ? error.message : String(error)))
    }
  }

  async send(workId: string, command: ExternalCommentCommand): Promise<boolean> {
    if (this.busy.get(workId)) return false
    const state = this.stateFor(workId)
    if (!state) { this.errors.set(workId, 'Refresh external comments before sending.'); return false }
    const existing = state.operations.find(operation => operation.requestId === command.requestId)
    const target = existing ? existing.command.target : { provider: state.provider, documentId: state.documentId, externalKey: state.externalKey }
    if (target) command = { ...command, target }
    this.busy.set(workId, true)
    try {
      const result = await this.api(workId).sendWorkExternalComment(workId, command)
      this.tokens.set(workId, (this.tokens.get(workId) ?? 0) + 1)
      this.apply(workId, result)
      this.errors.delete(workId)
      return result.operations.some(operation => operation.requestId === command.requestId && operation.status === 'sent')
    } catch (error) {
      this.errors.set(workId, externalCommentError(error instanceof Error ? error.message : String(error)))
      return false
    } finally { this.busy.set(workId, false) }
  }

  watch(workId: string): () => void {
    void this.load(workId)
    const unwatch = this.watches.watch(workId, () => this.load(workId, true))
    const api = this.api(workId)
    const unsubscribe = serverConnections.eventsForApi(api).subscribe('annotations.changed', change => {
      if (change.kind === 'work' && change.targetId === workId) void this.load(workId)
    })
    return () => { unwatch(); unsubscribe() }
  }

  private apply(workId: string, value: WorkExternalComments): void {
    const link = this.link(workId)
    if (!link || value.provider !== link.provider || value.documentId !== link.externalId || value.externalKey !== link.externalKey) return
    const current = this.states.get(workId)
    // Polling an unchanged document must not invalidate every thread component.
    if (current && JSON.stringify(current) === JSON.stringify(value)) return
    this.states.set(workId, value)
  }
}

function externalCommentError(message: string): string {
  if (/Unknown method.*(?:readWorkExternalComments|refreshWorkExternalComments|sendWorkExternalComment)/i.test(message)) {
    return 'This host does not support external comment sharing yet. Update or restart the host, then try again.'
  }
  return message
}
