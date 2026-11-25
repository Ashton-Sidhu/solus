import type { OutboundPrompt } from '@solus/contracts/types'
import type { QueueAttachment, QueuedModelSelection } from '@solus/contracts/session-queue'
import type { PickerSelection } from '../../../pickers/lib/picker-selection'
import type { SessionQueueController } from '../../../../contexts/workspace/session-queue.store.svelte'
import { clipboardMedia, type ComposerClipboard } from '../../../input/lib/attachment-upload'

/** Editing is a separate draft. The live queue and composer stay unchanged
 * until Save; a conflicting revision leaves the draft available to the user. */
export class QueueEdit {
  text = $state('')
  attachments = $state<QueueAttachment[] | undefined>()
  busy = $state(false)
  error = $state('')
  model = $state<PickerSelection>()!
  private modelChanged = $state(false)
  private attachmentsChanged = $state(false)
  constructor(private readonly queue: SessionQueueController, private readonly tabId: string, readonly source: OutboundPrompt,
    private readonly initialModel: QueuedModelSelection,
    private readonly contextWindowFor: (provider: PickerSelection['provider'], modelId: string | null) => number | null) {
    const { modelId, reasoningEffort, fastMode } = initialModel.modelConfig
    this.model = { provider: initialModel.provider, modelId, reasoningEffort, fastMode }
    this.text = source.text
    this.attachments = source.queueAttachments?.map((item) => ({ ...item }))
  }
  get changed(): boolean { return this.text !== this.source.text || this.attachmentsChanged || this.modelChanged }
  markModelChanged(): void { this.modelChanged = true }
  get selection(): QueuedModelSelection | undefined {
    if (!this.modelChanged) return undefined
    const { provider, ...model } = this.model
    const sameModel = provider === this.initialModel.provider && model.modelId === this.initialModel.modelConfig.modelId
    return { provider, modelConfig: { ...model, contextWindow: sameModel ? this.initialModel.modelConfig.contextWindow : this.contextWindowFor(provider, model.modelId) } }
  }
  removeAttachment(index: number): void { this.attachments?.splice(index, 1); this.attachmentsChanged = true }
  async add(files: File[]): Promise<void> {
    this.busy = true
    this.error = ''
    try {
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
  /** Attaches the images and videos of a paste, as the composer does. Returns
   * false when the paste has none, so its text goes into the field. */
  paste(clipboard: ComposerClipboard): boolean {
    const media = clipboardMedia(clipboard)
    if (media.length === 0) return false
    void this.add(media)
    return true
  }
  async save(): Promise<boolean> {
    if (this.busy) return false
    if (!this.text.trim()) { this.error = 'Enter a prompt before saving.'; return false }
    this.busy = true
    this.error = ''
    try { await this.queue.edit(this.tabId, this.source, this.text, this.attachmentsChanged ? this.attachments : undefined, this.selection); return true }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); return false }
    finally { this.busy = false }
  }
}
