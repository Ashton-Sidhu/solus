// Adapted from T3 Code apps/mobile/src/features/workspace/AndroidWorkspaceNavigation.tsx (MIT, see UPSTREAM.md).
import type { WorkspaceTab } from './workspace-tabs-state'

/** Other clients own their workspace navigation chrome. */
export function AndroidWorkspaceNavigation(_props: { readonly selectedTab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  return null
}
