import {
  modalSizeStyle,
  readSavedModalSize,
  saveModalSize,
  type ModalAnchor,
  type ModalSize,
  type ModalSizeKey,
} from './modal-size'

/** One modal's size: the reader's own size, or null for the modal's default.
 *  The size changes live during a drag and is saved once, when the drag ends. */
export class ResizableModal {
  size = $state<ModalSize | null>(null)
  readonly style = $derived(modalSizeStyle(this.size))

  constructor(
    readonly key: ModalSizeKey,
    readonly anchor: ModalAnchor = 'center',
  ) {
    this.size = readSavedModalSize(key)
  }

  resize(size: ModalSize): void {
    this.size = size
  }

  commit(): void {
    saveModalSize(this.key, this.size)
  }

  /** Back to the modal's default size. */
  reset(): void {
    this.size = null
    saveModalSize(this.key, null)
  }
}
