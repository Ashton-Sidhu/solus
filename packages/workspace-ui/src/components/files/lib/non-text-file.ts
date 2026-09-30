import type { FilePreviewResult } from '@solus/contracts/types'

/** A file the pane shows without an editor: media it can display, or any
 *  other binary file it can only describe. */
export type NonTextFile = Extract<FilePreviewResult, { ok: true; kind: 'media' | 'binary' }>

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
