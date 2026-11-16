import type { AppFileView } from '@solus/contracts/apps'
import { blobFromParts, readAppFileParts, type AppHostCall } from '@solus/client-core/app-files'
import { filePreviewKind } from './app-file-preview'

/**
 * The preview of the file the Files section has selected: read when the
 * selection changes, dropped when it changes again. A read that a newer
 * selection overtook never shows. The picture lives as an object URL, which
 * is let go with the preview.
 */
export class FilePreview {
  /** The picture to draw; null while it loads, when it failed, or for a file with no preview. */
  url = $state<string | null>(null)
  isLoading = $state(false)
  hasFailed = $state(false)
  private fileId: string | null = null
  private read = 0

  /** Shows `file`, or nothing. The same file is not read again. */
  show(call: AppHostCall, file: AppFileView | null): void {
    if (file?.id === this.fileId) return
    this.clear()
    this.fileId = file?.id ?? null
    const kind = file ? filePreviewKind(file) : null
    if (!file || !kind) return
    const read = ++this.read
    this.isLoading = true
    void (async () => {
      try {
        const blob = blobFromParts(await readAppFileParts(call, file.id), file.type)
        const picture = kind === 'pdf' ? await (await import('./pdf-thumbnail')).pdfFirstPage(await blob.arrayBuffer()) : blob
        if (read !== this.read) return
        this.url = URL.createObjectURL(picture)
      } catch {
        if (read === this.read) this.hasFailed = true
      } finally {
        if (read === this.read) this.isLoading = false
      }
    })()
  }

  dispose(): void {
    this.clear()
    this.fileId = null
  }

  private clear(): void {
    this.read++
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    this.isLoading = false
    this.hasFailed = false
  }
}
