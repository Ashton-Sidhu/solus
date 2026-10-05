import type { OutboundPrompt, Attachment } from '@solus/contracts/types'
import type { QueueAttachment, SessionQueueMutation } from '@solus/contracts/session-queue'
import type { WorkspaceContext } from './workspace.context.svelte'
import { reconcileQueuedPromptsForSession } from './session-transcript'
import { readFileDataUrl } from '../../components/input/lib/attachment-upload'
import { composeAttachmentContext } from './prompt-composer'
import { uuid } from '@solus/contracts/uuid'

type QueueWorkspace = Pick<WorkspaceContext, 'apiFor' | 'ctxFor' | 'sessionFor'>

/** Queue commands share the session's authoritative projection. Refreshes must
 * not replace a newer live event, and mutation replies never replay old state. */
export class SessionQueueController {
  constructor(private readonly workspace: QueueWorkspace) {}

  async refresh(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const version = session.queueVersion ?? 0
    const snapshot = await this.workspace.apiFor(tabId).sessionQueue(this.workspace.ctxFor(tabId))
    if (session !== this.workspace.sessionFor(tabId) || version !== (session.queueVersion ?? 0)) return
    session.queueHeld = snapshot.held
    reconcileQueuedPromptsForSession(session, snapshot.entries)
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
      const dataUrl = await readFileDataUrl(file)
      const hostPath = await api.attachUpload(ctx, { name: file.name, mime: file.type || 'application/octet-stream', dataUrl })
      result.push({ id: uuid(), name: file.name, hostPath, type: file.type.startsWith('image/') ? 'image' : 'file', mimeType: file.type, size: file.size })
    }
    return result
  }

  async edit(tabId: string, prompt: OutboundPrompt, text: string, attachments: QueueAttachment[] | undefined): Promise<void> {
    if (!prompt.queueId) throw new Error('The prompt is no longer queued.')
    const serverId = this.workspace.sessionFor(tabId)?.run.serverId ?? ''
    const files: Attachment[] = attachments?.filter((item) => item.type !== 'image').map((item) => ({ ...item, path: item.hostPath ?? '' })) ?? []
    await this.change(tabId, { kind: 'edit', queueId: prompt.queueId, revision: prompt.revision ?? 0, text,
      attachments, attachmentContext: attachments === undefined ? undefined : files.map((file) =>
        attachments.find((item) => item.id === file.id)?.context ?? composeAttachmentContext([file], serverId)).join('\n'),
      imageRefs: attachments?.flatMap((item) => item.type === 'image' && item.hostPath && !item.dataUrl ? [{ hostPath: item.hostPath, mimeType: item.mimeType || 'image/png', name: item.name }] : []),
      images: attachments?.flatMap((item) => item.type === 'image' && item.dataUrl ? [{ mimeType: item.mimeType || 'image/png', dataUrl: item.dataUrl }] : []),
    })
  }
}
