// Adapted from T3 Code apps/mobile/src/features/workspace/WorkspaceTabPanes.tsx (MIT, see UPSTREAM.md).
import { Activity, useState, type ReactNode } from 'react'
import { Platform, View } from 'react-native'
import type { WorkspaceTab } from './workspace-tabs-state'

const TABS: readonly WorkspaceTab[] = ['chats', 'pullRequests']

/**
 * The two list tabs of the Android workspace. A tab mounts on its first visit
 * and then stays mounted while hidden, so returning to it shows its list as
 * it was left, in one frame, instead of an empty list that fills in. A hidden
 * tab keeps its state but runs no effects: its search Back handler, header
 * options, focus refresh, and host reads are off until it shows again, and
 * then read again under their freshness guards. At most the two list tabs are
 * kept; Settings is a stack route and is never retained here.
 *
 * iOS retains each tab's native controller tree instead (WorkspaceNativeTabs),
 * so it renders only the selected tab.
 */
export function WorkspaceTabPanes(props: {
  readonly selected: WorkspaceTab
  readonly renderTab: (tab: WorkspaceTab) => ReactNode
}) {
  const [visited, setVisited] = useState<readonly WorkspaceTab[]>(() => [props.selected])
  if (Platform.OS !== 'android') return props.renderTab(props.selected)
  if (!visited.includes(props.selected)) setVisited([...visited, props.selected])
  return TABS.map((tab) =>
    visited.includes(tab) || tab === props.selected ? (
      <Activity key={tab} mode={tab === props.selected ? 'visible' : 'hidden'}>
        <View className="flex-1">{props.renderTab(tab)}</View>
      </Activity>
    ) : null,
  )
}
