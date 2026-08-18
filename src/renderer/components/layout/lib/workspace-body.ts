import { isArtifactRoute, isPageRoute, type RouteRef } from '../../../contexts/workspace/routing/route-registry'
import type { PaneId } from '../../../contexts/workspace/routing/location'
import type { Tab } from '../../../../shared/types'

export const MIN_PRIMARY_PANE_WIDTH = 400

/**
 * Every pane constraint below is a percentage of the split it sits in, which is
 * what PaneForge takes and what lets its own `autoSaveId` persistence work: the
 * library keys a saved layout by the panes' constraints, so a constraint derived
 * from the live container width would change the key on every window resize and
 * lose the layout it just saved.
 *
 * A share scales with the viewport on its own, which is the point — no measuring,
 * no conversion, one number per role.
 */
export const PRIMARY_PANE_MIN_SIZE = 25
export const COMPANION_PANE_MIN_SIZE = 25
export const COMPANION_PANE_DEFAULT_SIZE = 50
/**
 * A primary pane holding a list sidebar rather than a chat column. The docked PR
 * inbox is navigation beside its review, so the chat column's floor — sized for a
 * conversation and its composer — would strand it at nearly half the split.
 */
export const LIST_PRIMARY_PANE_MIN_SIZE = 15
export const LIST_PRIMARY_PANE_SIZE = 19

/**
 * The session sidebar's share of the window: ~218px at 1280, ~245px at 1440,
 * ~490px at 2880. A share has no ceiling, so a very wide display gives the
 * sidebar more room than one line of text per row needs — that is the trade a
 * percentage makes in exchange for scaling with no measurement.
 */
export const SIDEBAR_PANE_MIN_SIZE = 14
export const SIDEBAR_PANE_DEFAULT_SIZE = 17
export const SIDEBAR_PANE_MAX_SIZE = 24
export const MAX_RETAINED_CONVERSATION_TRANSCRIPTS = 4

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
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_DEFAULT_WIDTH = 380
export const SIDEBAR_MAX_WIDTH = 400

/**
 * The width of a workspace rail: clamp(200px, 17%, 380px) of the window it sits
 * in, so a rail is a share of the display rather than one fixed width — ~200px
 * on an iPad, ~245px on a 15" MacBook Pro, ~294px on a 16", 380px on a 5K. The
 * floor keeps a session title readable on the smallest tablet; the cap stops an
 * ultrawide from widening a column that holds one line of text per row.
 *
 * Both rails read this: the session sidebar on the left and the project rail on
 * the right are the same furniture on the same window, so they are the same
 * width. `projectRailWidth` only narrows the result when the conversation view
 * beside it is too small to give the full measure away.
 */
export function defaultWorkspaceRailWidth(viewportWidth: number): number {
  return Math.round(
    Math.min(SIDEBAR_DEFAULT_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, viewportWidth * 0.17)),
  )
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
 * Which pane the maximize key acts on. Only a companion pane can be maximized —
 * the leading pane already owns the column the maximized surface would cover —
 * so the key follows focus into a companion and otherwise takes the last one
 * opened. A pane that is already maximized stays the target wherever focus sits,
 * so the same press always restores it.
 */
export function maximizeTargetPaneId(
  companionPaneIds: readonly PaneId[],
  focusedPaneId: PaneId,
  maximizedPaneId: PaneId | null,
): PaneId | null {
  if (maximizedPaneId && companionPaneIds.includes(maximizedPaneId)) return maximizedPaneId
  if (companionPaneIds.includes(focusedPaneId)) return focusedPaneId
  return companionPaneIds.at(-1) ?? null
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
 * A companion pane earns its width once it has something to show. A review whose
 * source session has no working directory has no change to read, so the pane
 * stays closed rather than opening onto an error.
 */
export function isCompanionVisible(
  ref: RouteRef | null,
  workspace: Pick<WorkspaceTabs, 'sessionFor'>,
): boolean {
  if (!ref) return false
  if (ref.name === 'review') return !!workspace.sessionFor(ref.params.sourceTabId)?.run.workingDirectory
  return true
}
