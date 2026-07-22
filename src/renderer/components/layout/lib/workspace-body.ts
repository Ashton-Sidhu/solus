import type { PaneContent, PaneSlot } from '../../../contexts/pane-view.store.svelte'
import type { Session, Tab } from '../../../../shared/types'
import { branchKeyFor } from '../../../lib/sessionUtils'
import { paneBoundsPercent, pixelsToPercent } from '../../../lib/resizablePane'

export const SECONDARY_CONTENT_DELAY_MS = 90
export const SECONDARY_SHELL_EXIT_MS = 140

export const MIN_PRIMARY_PANE_WIDTH = 400
export const MIN_SECONDARY_PANE_WIDTH = 360

export function defaultWorkspaceRailWidth(viewportWidth: number): number {
  return Math.round(Math.min(400, Math.max(280, viewportWidth * 0.19)))
}

export function clampSecondaryPaneWidth(desiredWidth: number, containerWidth: number): number {
  if (containerWidth < MIN_PRIMARY_PANE_WIDTH + MIN_SECONDARY_PANE_WIDTH) {
    return Math.round(containerWidth / 2)
  }
  return Math.min(
    containerWidth - MIN_PRIMARY_PANE_WIDTH,
    Math.max(MIN_SECONDARY_PANE_WIDTH, desiredWidth),
  )
}

export function secondaryPaneBounds(containerWidth: number): { min: number; max: number } {
  if (containerWidth < MIN_PRIMARY_PANE_WIDTH + MIN_SECONDARY_PANE_WIDTH) {
    return { min: 50, max: 50 }
  }
  return paneBoundsPercent(
    containerWidth,
    MIN_SECONDARY_PANE_WIDTH,
    containerWidth - MIN_PRIMARY_PANE_WIDTH,
  )
}

export function primaryPaneMinSize(containerWidth: number): number {
  return containerWidth < MIN_PRIMARY_PANE_WIDTH + MIN_SECONDARY_PANE_WIDTH
    ? 50
    : pixelsToPercent(MIN_PRIMARY_PANE_WIDTH, containerWidth)
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

export function visibleWorkspaceTabIds(
  workspace: WorkspaceTabs,
  activeSession: Session | undefined,
  splitTabId: string | null,
): string[] {
  const openTabIds = workspace.tabOrder.filter((tabId) => workspace.tabs[tabId])
  if (activeSession?.loadingHistory) return openTabIds
  const activeBranchKey = branchKeyFor(activeSession)
  return openTabIds.filter(
    (tabId) => tabId === splitTabId || branchKeyFor(workspace.sessionFor(tabId)) === activeBranchKey,
  )
}

export function isSecondaryContentVisible(
  content: PaneContent,
  workspace: Pick<WorkspaceTabs, 'sessionFor'>,
): boolean {
  return content.kind !== 'empty' &&
    (content.kind !== 'diff' || !!workspace.sessionFor(content.sourceTabId)?.workingDirectory)
}

export function shouldCollapseProjectPanelForSecondary(
  content: PaneContent,
  isVisible: boolean,
): boolean {
  return isVisible && content.kind !== 'conversation'
}

export function focusedSplitChatTabId(
  content: PaneContent,
  focusedPane: PaneSlot,
  splitTabId: string | null,
): string | null {
  if (content.kind !== 'conversation' || !content.tabId) return null
  return focusedPane === 'secondary' && content.tabId === splitTabId ? content.tabId : null
}
