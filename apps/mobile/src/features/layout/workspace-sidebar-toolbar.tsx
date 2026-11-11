import { Platform } from "react-native";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";

import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "./AdaptiveWorkspaceLayout";

export function AndroidWorkspaceSidebarButton() {
  const { layout, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  if (Platform.OS !== "android" || !layout.usesSplitView) return null;

  return (
    <AndroidHeaderIconButton
      accessibilityLabel={panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar"}
      icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
      onPress={togglePrimarySidebar}
    />
  );
}
