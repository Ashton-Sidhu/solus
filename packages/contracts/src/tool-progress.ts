import type { ToolProgress } from './types'

/**
 * What a client shows of a running MCP call's own progress
 * (docs/plans/mcp-first-class.md §5): the desktop and web tool row and the
 * mobile work log read the same answer.
 */
export interface ToolProgressView {
  /** The server's plain-text message, when it sent one. */
  message: string | null
  /** 0 to 1 for the bar; null when the server gave no usable total. */
  fraction: number | null
  /** The bar as a whole percent, for the label and for assistive technology. */
  percent: number | null
}

/** Null when the call reported nothing yet: the row stays as it was. */
export function toolProgressView(progress: ToolProgress | undefined): ToolProgressView | null {
  if (!progress) return null
  const message = progress.message?.trim() || null
  const total = progress.total
  const fraction = total !== undefined && Number.isFinite(total) && total > 0 && Number.isFinite(progress.progress)
    ? Math.min(1, Math.max(0, progress.progress / total))
    : null
  return { message, fraction, percent: fraction === null ? null : Math.floor(fraction * 100) }
}
