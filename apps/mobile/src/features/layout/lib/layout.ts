/**
 * Compact stack or persistent session sidebar, from the window size alone, so
 * iPad multitasking and rotation change the layout and a device name never
 * does. Thresholds adapted from T3 Code `apps/mobile/src/lib/layout.ts`
 * (MIT, see apps/mobile/UPSTREAM.md).
 */

/** Narrower than this, a sidebar would crowd the conversation. */
export const SPLIT_LAYOUT_MIN_WIDTH = 720
/** Keeps a landscape iPhone compact. */
export const SPLIT_LAYOUT_MIN_HEIGHT = 600
const SIDEBAR_MIN_WIDTH = 280
const SIDEBAR_MAX_WIDTH = 380
/** Long lines are hard to read; the conversation stops widening here. */
export const CONVERSATION_MAX_WIDTH = 860

export type WorkspaceLayout =
  | { variant: 'compact' }
  | { variant: 'split'; sidebarWidth: number }

export function deriveLayout(window: { width: number; height: number }): WorkspaceLayout {
  if (window.width < SPLIT_LAYOUT_MIN_WIDTH || window.height < SPLIT_LAYOUT_MIN_HEIGHT) return { variant: 'compact' }
  const sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(window.width * 0.32)))
  return { variant: 'split', sidebarWidth }
}
