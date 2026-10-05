import type { QueuedPromptSnapshot } from '@solus/contracts/types'
import type { QueueAttachment, SessionQueueMutation } from '@solus/contracts/session-queue'
import type { PickedFile } from './attachments'

interface QueueCommands {
  changeQueue(mutation: SessionQueueMutation): Promise<void>
  uploadQueueFiles(files: readonly PickedFile[]): Promise<QueueAttachment[]>
}

/** A separate draft keeps the main composer's text and files intact. */
export class QueueDraft {
  text: string
  attachments: QueueAttachment[] | undefined
  private filesChanged = false
  constructor(readonly source: QueuedPromptSnapshot, private readonly commands: QueueCommands) {
    this.text = source.text
    this.attachments = source.attachments?.map((item) => ({ ...item }))
  }
  removeFile(id: string): void {
    this.attachments = this.attachments?.filter((item) => item.id !== id)
    this.filesChanged = true
  }
  async addFiles(files: readonly PickedFile[]): Promise<void> {
    if ((this.attachments?.length ?? 0) + files.length > 8) throw new Error('A prompt can have up to eight attachments.')
    if (!this.attachments && (this.source.images?.length || this.source.imageRefs?.length)) throw new Error('This older prompt has no editable file metadata. Its files will be kept.')
    const added = await this.commands.uploadQueueFiles(files)
    this.attachments = [...(this.attachments ?? []), ...added]
    this.filesChanged = true
  }
  async save(): Promise<void> {
    if (!this.text.trim()) throw new Error('Enter a prompt before saving.')
    const files = this.filesChanged ? this.attachments ?? [] : undefined
    await this.commands.changeQueue({ kind: 'edit', queueId: this.source.queueId, revision: this.source.revision ?? 0, text: this.text,
      attachments: files,
      attachmentContext: files?.filter((item) => item.type !== 'image').map((item) => item.context ?? `[Attached file: ${item.hostPath}]`).join('\n'),
      imageRefs: files?.flatMap((item) => item.type === 'image' && item.hostPath && !item.dataUrl ? [{ hostPath: item.hostPath, mimeType: item.mimeType || 'image/png', name: item.name }] : []),
      images: files?.flatMap((item) => item.type === 'image' && item.dataUrl ? [{ dataUrl: item.dataUrl, mimeType: item.mimeType || 'image/png' }] : []),
    })
  }
}
