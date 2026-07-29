import type { PaneContent, PaneSlot } from '../../../contexts/workspace/pane-view.store.svelte'
import type { Session, Tab } from '../../../../shared/types'
import { paneBoundsPercent, pixelsToPercent } from '../../../lib/resizablePane'

export const SECONDARY_CONTENT_DELAY_MS = 90
export const SECONDARY_SHELL_EXIT_MS = 140

export const MIN_PRIMARY_PANE_WIDTH = 400
export const MIN_SECONDARY_PANE_WIDTH = 360
/**
 * Bounds for a primary pane holding a list sidebar rather than a chat column.
 * The docked PR inbox is navigation beside its review, so 400px — sized for a
 * conversation and its composer — strands it at nearly half the split.
 */
export const MIN_LIST_PRIMARY_PANE_WIDTH = 228
export const MAX_LIST_PRIMARY_PANE_WIDTH = 340

/**
 * The docked list sidebar's own measure: clamp(228px, 19%, 340px). Expressed as
 * a width rather than a split ratio because the design caps it — past ~1790px
 * of split, a ratio keeps widening a column that holds one line of text.
 */
export function listSidebarPrimaryWidth(containerWidth: number): number {
  return Math.min(
    MAX_LIST_PRIMARY_PANE_WIDTH,
    Math.max(MIN_LIST_PRIMARY_PANE_WIDTH, Math.round(containerWidth * 0.19)),
  )
}
export const MAX_RETAINED_CONVERSATION_TRANSCRIPTS = 4

/**
 * Keep heavy transcript rows for the visible chats plus the most recently
 * visited hidden chats. ConversationView itself stays mounted, preserving its
 * local interaction state; only cold message component trees are released.
 */
export function retainedConversationTabIds(
  recentTabIds: readonly string[],
  visibleTabIds: readonly string[],
  openTabIds: readonly string[],
  limit = MAX_RETAINED_CONVERSATION_TRANSCRIPTS,
): string[] {
  const open = new Set(openTabIds)
  const retained: string[] = []
  const add = (tabId: string) => {
    if (open.has(tabId) && !retained.includes(tabId)) retained.push(tabId)
  }

  for (const tabId of visibleTabIds) add(tabId)
  for (const tabId of recentTabIds) add(tabId)
  return retained.slice(0, Math.max(limit, visibleTabIds.length))
}

export function defaultWorkspaceRailWidth(viewportWidth: number): number {
  return Math.round(Math.min(400, Math.max(280, viewportWidth * 0.19)))
}

export function clampSecondaryPaneWidth(
  desiredWidth: number,
  containerWidth: number,
  minPrimaryWidth = MIN_PRIMARY_PANE_WIDTH,
): number {
  if (containerWidth < minPrimaryWidth + MIN_SECONDARY_PANE_WIDTH) {
    return Math.round(containerWidth / 2)
  }
  return Math.min(
    containerWidth - minPrimaryWidth,
    Math.max(MIN_SECONDARY_PANE_WIDTH, desiredWidth),
  )
}

export function secondaryPaneBounds(
  containerWidth: number,
  minPrimaryWidth = MIN_PRIMARY_PANE_WIDTH,
): { min: number; max: number } {
  if (containerWidth < minPrimaryWidth + MIN_SECONDARY_PANE_WIDTH) {
    return { min: 50, max: 50 }
  }
  return paneBoundsPercent(
    containerWidth,
    MIN_SECONDARY_PANE_WIDTH,
    containerWidth - minPrimaryWidth,
  )
}

export function primaryPaneMinSize(
  containerWidth: number,
  minPrimaryWidth = MIN_PRIMARY_PANE_WIDTH,
): number {
  return containerWidth < minPrimaryWidth + MIN_SECONDARY_PANE_WIDTH
    ? 50
    : pixelsToPercent(minPrimaryWidth, containerWidth)
}

export function secondaryPaneDefaultSize(
  width: number,
  containerWidth: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, pixelsToPercent(width, containerWidth)))
}

interface WorkspaceTabs {
  tabOrder: string[]
  tabs: Record<string, Tab>
  sessionFor(tabId: string): Session | undefined
}

/**
 * Which tabs belong to the active tab's project + branch group. Grouping keys
 * come from `branchKeyOf` — the SAME environment-derived key the session sidebar
 * groups by — rather than the live `session.gitContext`. A resumed session
 * (from a create-session card, the picker, or a pinned entry) hydrates its
 * `gitContext` in the background, so keying off it would drop the tab into a
 * lonely `::no branch` group and hide every real sibling until Git answers. The
 * environment key resolves off the cwd's cached status, so it agrees with the
 * sidebar immediately — even while the resumed session is still loading its
 * history. Filtering by that key the whole time keeps the strip scoped to the
 * active group; bailing to every tab during the load flashed all projects into
 * the strip until history finished.
 */
export function visibleWorkspaceTabIds(
  workspace: WorkspaceTabs,
  activeTabId: string,
  splitTabId: string | null,
  branchKeyOf: (tabId: string) => string,
): string[] {
  const openTabIds = workspace.tabOrder.filter((tabId) => workspace.tabs[tabId])
  const activeBranchKey = branchKeyOf(activeTabId)
  return openTabIds.filter(
    (tabId) => tabId === splitTabId || branchKeyOf(tabId) === activeBranchKey,
  )
}

export function isSecondaryContentVisible(
  content: PaneContent,
  workspace: Pick<WorkspaceTabs, 'sessionFor'>,
): boolean {
  return content.kind !== 'empty' &&
    (content.kind !== 'diff' || !!content.cwd || !!workspace.sessionFor(content.sourceTabId)?.workingDirectory)
}

export function focusedSplitChatTabId(
  content: PaneContent,
  focusedPane: PaneSlot,
  splitTabId: string | null,
): string | null {
  if (content.kind !== 'conversation' || !content.tabId) return null
  return focusedPane === 'secondary' && content.tabId === splitTabId ? content.tabId : null
}
