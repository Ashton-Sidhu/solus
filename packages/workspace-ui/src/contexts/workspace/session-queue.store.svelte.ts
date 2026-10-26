import type { HostApi } from '@solus/client-core/host-api'
import type { OutboundPrompt, Attachment, Session } from '@solus/contracts/types'
import type { QueueAttachment, SessionQueueMutation } from '@solus/contracts/session-queue'
import type { WorkspaceContext } from './workspace.context.svelte'
import { reconcileQueuedPromptsForSession } from './session-transcript'
import { readFileDataUrl } from '../../components/input/lib/attachment-upload'
import { composeAttachmentContext } from './prompt-composer'
import { uuid } from '@solus/contracts/uuid'
import { attachmentKind } from '@solus/contracts/media-types'
import { runHost } from './run-location'

type QueueWorkspace = Pick<WorkspaceContext, 'apiFor' | 'ctxFor' | 'sessionFor'>

/** Queue commands share the session's authoritative projection. Refreshes must
 * not replace a newer live event, and mutation replies never replay old state. */
export class SessionQueueController {
  private readonly reads = new WeakMap<Session, { api: HostApi; promise: Promise<void> }>()

  constructor(private readonly workspace: QueueWorkspace) {}

  /** Mounted views share the session read; reconnects and commands refresh it. */
  async ensure(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const read = this.reads.get(session)
    return read?.api === this.workspace.apiFor(tabId) ? read.promise : this.refresh(tabId)
  }

  async refresh(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const version = session.queueVersion ?? 0
    const api = this.workspace.apiFor(tabId)
    const ctx = this.workspace.ctxFor(tabId)
    const promise = Promise.resolve().then(() => api.sessionQueue(ctx)).then((snapshot) => {
      if (this.reads.get(session)?.promise !== promise || api !== this.workspace.apiFor(tabId) || session !== this.workspace.sessionFor(tabId) || version !== (session.queueVersion ?? 0)) return
      session.queueHeld = snapshot.held
      reconcileQueuedPromptsForSession(session, snapshot.entries)
    }).catch((error: Error) => {
      if (this.reads.get(session)?.promise === promise) this.reads.delete(session)
      throw error
    })
    this.reads.set(session, { api, promise })
    await promise
  }

  async change(tabId: string, mutation: SessionQueueMutation): Promise<void> {
    await this.workspace.apiFor(tabId).sessionQueueChange(this.workspace.ctxFor(tabId), mutation)
  }

  async upload(tabId: string, files: File[]): Promise<QueueAttachment[]> {
    if (files.length > 8) throw new Error('A prompt can have up to eight attachments.')
    const api = this.workspace.apiFor(tabId)
    const ctx = this.workspace.ctxFor(tabId)
    const result: QueueAttachment[] = []
    for (const file of files) {
      const kind = attachmentKind({ name: file.name, mimeType: file.type })
      // The data URL must carry the type the host is told about.
      const typed = file.type === kind.mimeType ? file : new Blob([file], { type: kind.mimeType })
      const dataUrl = await readFileDataUrl(typed)
      const hostPath = await api.attachUpload(ctx, { name: file.name, mime: kind.mimeType, dataUrl })
      result.push({ id: uuid(), name: file.name, hostPath, type: kind.type, mimeType: kind.mimeType, size: file.size })
    }
    return result
  }

  async edit(tabId: string, prompt: OutboundPrompt, text: string, attachments: QueueAttachment[] | undefined): Promise<void> {
    if (!prompt.queueId) throw new Error('The prompt is no longer queued.')
    const serverId = runHost(this.workspace.sessionFor(tabId)?.run) ?? ''
    const files: Attachment[] = attachments?.filter((item) => item.type !== 'image').map((item) => ({ ...item, path: item.hostPath ?? '' })) ?? []
    await this.change(tabId, { kind: 'edit', queueId: prompt.queueId, revision: prompt.revision ?? 0, text,
      attachments, attachmentContext: attachments === undefined ? undefined : files.map((file) =>
        attachments.find((item) => item.id === file.id)?.context ?? composeAttachmentContext([file], serverId)).join('\n'),
      imageRefs: attachments?.flatMap((item) => item.type === 'image' && item.hostPath && !item.dataUrl ? [{ hostPath: item.hostPath, mimeType: item.mimeType || 'image/png', name: item.name }] : []),
      images: attachments?.flatMap((item) => item.type === 'image' && item.dataUrl ? [{ mimeType: item.mimeType || 'image/png', dataUrl: item.dataUrl }] : []),
    })
  }
}
