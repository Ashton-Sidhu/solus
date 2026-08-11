import { isArtifactRoute, isPageRoute, type RouteRef } from '../../../contexts/workspace/routing/route-registry'
import type { Session, Tab } from '../../../../shared/types'
import { paneBoundsPercent, pixelsToPercent } from '../../../lib/resizablePane'

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
 * Whether the conversation column is showing the new-tab home rather than a
 * transcript. Mirrors ConversationView's own gate so the shell can lay the home
 * out as one centred block with the composer, instead of docking the composer at
 * the bottom of an otherwise empty column.
 */
export function isHomeVisible(
  session:
    | Pick<Session, 'agentSessionId' | 'handoffFrom' | 'messages' | 'statusCard' | 'loadingHistory'>
    | undefined,
  hasConversationNotice = false,
): boolean {
  if (!session) return false
  return (
    !session.loadingHistory &&
    !session.agentSessionId &&
    !session.handoffFrom &&
    session.messages.length === 0 &&
    !session.statusCard &&
    !hasConversationNotice
  )
}

/**
 * A fresh tab starts without the project rail, even when the user's conversation
 * preference is open. The rail may still be revealed explicitly; once the
 * session starts, its persisted conversation preference takes over.
 */
export function primaryProjectPanelOpen(
  hasStartedSession: boolean,
  persistedOpen: boolean,
  newTabPoppedOut: boolean,
): boolean {
  return hasStartedSession ? persistedOpen : newTabPoppedOut
}

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

/**
 * The task column's measure. It holds one line of text per row, so it is sized
 * rather than shared: past 440px the titles stop being the thing that runs out
 * of room and the column just gets emptier, and under 300px the row's trailing
 * slot starts eating the title.
 */
export const SIDEBAR_MIN_WIDTH = 280
export const SIDEBAR_DEFAULT_WIDTH = 320
export const SIDEBAR_MAX_WIDTH = 400

/**
 * clamp(280px, 19%, 320px) of the window it sits in. A laptop lands near the
 * floor so the conversation keeps the room, and a wide display stops at 320px
 * rather than widening a column that holds one line of text per row.
 */
export function defaultWorkspaceRailWidth(viewportWidth: number): number {
  return Math.round(
    Math.min(SIDEBAR_DEFAULT_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, viewportWidth * 0.19)),
  )
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

/**
 * Surfaces that read as a framed document beside the thread rather than as
 * another live column — they get the border and the stepped-back background.
 */
export function isFramedRoute(ref: RouteRef | null): boolean {
  // `prDiff` frames for the same reason `review` does: it opens beside a full
  // page (the PR review), not beside a conversation, so the two surfaces need a
  // seam between them rather than floating on one canvas.
  return (
    isArtifactRoute(ref) || isPageRoute(ref) || ref?.name === 'review' || ref?.name === 'prDiff'
  )
}

/**
 * A companion pane earns its width once it has something to show. A diff whose
 * source session has no working directory has nothing to diff, so the pane stays
 * closed rather than opening onto an error.
 */
export function isCompanionVisible(
  ref: RouteRef | null,
  workspace: Pick<WorkspaceTabs, 'sessionFor'>,
): boolean {
  if (!ref) return false
  if (ref.name === 'diff') return !!workspace.sessionFor(ref.params.sourceTabId)?.run.workingDirectory
  return true
}
