import type { FilePreviewResult } from '@solus/contracts/types'

/** A file the pane shows without an editor: media it can display, or any
 *  other binary file it can only describe. */
export type NonTextFile = Extract<FilePreviewResult, { ok: true; kind: 'media' | 'binary' }>

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  // The unit follows the rounded figure: 1023.6 KB reads as 1.0 MB, not 1024 KB.
  while (roundFileSize(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = roundFileSize(value)
  return `${rounded < 10 ? rounded.toFixed(1) : rounded} ${units[unit]}`
}

function roundFileSize(value: number): number {
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
}
