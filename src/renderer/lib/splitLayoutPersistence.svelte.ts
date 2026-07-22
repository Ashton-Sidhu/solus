import { untrack } from 'svelte'
import { MAX_SECONDARY_RATIO, MIN_SECONDARY_RATIO } from '../contexts/workspace/pane-view.store.svelte'
import { type SettingsContext, type WindowContext, type WorkspaceContext } from '../contexts'

export function setupSplitLayoutPersistence(
  settings: SettingsContext,
  session: WorkspaceContext,
  windowCtx: WindowContext,
): void {
  const supportsSplitLayout = windowCtx.viewMode === 'editor' || windowCtx.isWeb

  // Restore only the durable split-chat base content. Temporary overlays are
  // intentionally absent from settings and always start closed.
  if (supportsSplitLayout) {
    const savedSplitLayout = settings.splitLayout
    if (savedSplitLayout) {
      if (session.tabs[savedSplitLayout.splitTabId]) {
        session.panes.openSplitChat(savedSplitLayout.splitTabId)
        session.panes.secondaryRatio = savedSplitLayout.secondaryRatio
      } else {
        settings.update({ splitLayout: null })
      }
    }
  }

  let persistedSplitTabId = settings.splitLayout?.splitTabId ?? null
  let splitAreaWidth: number | null = null
  let lastSecondaryWidth = session.panes.secondaryWidth

  // Persist only split open/close and user resize transitions. Overlay geometry
  // changes secondaryRatio too, so it must not be treated as durable layout.
  $effect(() => {
    if (session.hydrating || !supportsSplitLayout) return
    const content = session.panes.secondaryContent
    const splitTabId = content.kind === 'conversation' ? (content.tabId ?? null) : null
    const secondaryRatio = session.panes.secondaryRatio
    const secondaryWidth = session.panes.secondaryWidth
    const hasResized = session.panes.hasResized
    const savedSplitLayout = settings.splitLayout

    if (!splitTabId) {
      persistedSplitTabId = null
      splitAreaWidth = null
      lastSecondaryWidth = secondaryWidth
      if (savedSplitLayout) untrack(() => settings.update({ splitLayout: null }))
      return
    }

    if (splitTabId !== persistedSplitTabId) {
      persistedSplitTabId = splitTabId
      splitAreaWidth = secondaryWidth / secondaryRatio
      lastSecondaryWidth = secondaryWidth
      untrack(() => settings.update({ splitLayout: { splitTabId, secondaryRatio } }))
      return
    }

    if (!hasResized) {
      lastSecondaryWidth = secondaryWidth
      // Initial PaneForge layout gives us the real split-area width. Ignore
      // overlay-specific ratios, which differ from the saved base-chat ratio.
      if (savedSplitLayout?.secondaryRatio === secondaryRatio) {
        splitAreaWidth = secondaryWidth / secondaryRatio
      }
      return
    }

    if (secondaryWidth === lastSecondaryWidth) return
    lastSecondaryWidth = secondaryWidth
    const resizedRatio = Math.min(
      MAX_SECONDARY_RATIO,
      Math.max(
        MIN_SECONDARY_RATIO,
        splitAreaWidth ? secondaryWidth / splitAreaWidth : secondaryRatio,
      ),
    )
    if (savedSplitLayout?.secondaryRatio === resizedRatio) return
    untrack(() => settings.update({ splitLayout: { splitTabId, secondaryRatio: resizedRatio } }))
  })
}
