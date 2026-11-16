import type { BrowserPageDialog } from '@solus/contracts/browser-types'

/**
 * How every client words a page's JavaScript dialog: desktop and web over the
 * streamed surface, and the phone's browser viewer. One wording, so the same
 * page asks the same question everywhere.
 */
export interface BrowserDialogChoices {
  title: string
  /** The page's own text; the leave-page question has none worth showing. */
  message: string
  accept: string
  /** Absent for an alert, which has only OK. */
  dismiss: string | null
}

export function browserDialogChoices(dialog: BrowserPageDialog): BrowserDialogChoices {
  if (dialog.type === 'beforeunload') {
    return { title: 'Leave this page?', message: 'Changes you made may not be saved.', accept: 'Leave', dismiss: 'Stay' }
  }
  return {
    title: 'The page says',
    message: dialog.message,
    accept: 'OK',
    dismiss: dialog.type === 'alert' ? null : 'Cancel',
  }
}

/** A byte count as a person reads it beside a file name. */
export function downloadSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}
