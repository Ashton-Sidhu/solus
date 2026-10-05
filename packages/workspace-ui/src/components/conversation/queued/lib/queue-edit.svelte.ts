import type { OutboundPrompt } from '@solus/contracts/types'
import type { QueueAttachment } from '@solus/contracts/session-queue'
import type { SessionQueueController } from '../../../../contexts/workspace/session-queue.store.svelte'

/** Editing is a separate draft. The live queue and composer stay unchanged
 * until Save; a conflicting revision leaves the draft available to the user. */
export class QueueEdit {
  text = $state('')
  attachments = $state<QueueAttachment[] | undefined>()
  busy = $state(false)
  error = $state('')
  private attachmentsChanged = false
  constructor(private readonly queue: SessionQueueController, private readonly tabId: string, private readonly source: OutboundPrompt) {
    this.text = source.text
    this.attachments = source.queueAttachments?.map((item) => ({ ...item }))
  }
  removeAttachment(index: number): void { this.attachments?.splice(index, 1); this.attachmentsChanged = true }
  async add(files: File[]): Promise<void> {
    this.busy = true
    this.error = ''
    try {
      if ((this.attachments?.length ?? 0) + files.length > 8) throw new Error('A prompt can have up to eight attachments.')
      if (this.attachments === undefined && (this.source.images?.length || this.source.attachments?.length)) {
        throw new Error('This older queue entry has no editable attachment metadata. Its existing files will be kept.')
      }
      const added = await this.queue.upload(this.tabId, files)
      this.attachments ??= []
      this.attachments.push(...added)
      this.attachmentsChanged = true
    } catch (error) { this.error = error instanceof Error ? error.message : String(error) }
    finally { this.busy = false }
  }
  async save(): Promise<boolean> {
    if (!this.text.trim()) { this.error = 'Enter a prompt before saving.'; return false }
    this.busy = true
    this.error = ''
    try { await this.queue.edit(this.tabId, this.source, this.text, this.attachmentsChanged ? this.attachments : undefined); return true }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); return false }
    finally { this.busy = false }
  }
}
