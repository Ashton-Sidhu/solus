// Adapted from T3 Code apps/mobile/src/features/workspace/useSystemWorkspaceTabBar.ts (MIT, see UPSTREAM.md).
import { Platform } from "react-native";

import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

/** A wide iPad window picks the tab in the sidebar (WorkspaceSidebarTabs), not in the tab bar. */
export function useSidebarWorkspaceTabs(): boolean {
  const { layout } = useAdaptiveWorkspaceLayout();
  return Platform.OS === "ios" && Platform.isPad && layout.usesSplitView;
}
