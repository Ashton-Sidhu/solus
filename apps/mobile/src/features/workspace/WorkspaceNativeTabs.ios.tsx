// Adapted from T3 Code apps/mobile/src/features/workspace/WorkspaceNativeTabs.ios.tsx (MIT, see UPSTREAM.md).
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Keyboard, Platform, View, type NativeSyntheticEvent } from "react-native";
import {
  Tabs,
  type TabSelectedEvent,
  type TabSelectionPreventedEvent,
  type TabSelectionRejectedEvent,
} from "react-native-screens";

import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useSidebarWorkspaceTabs } from "./use-sidebar-workspace-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WORKSPACE_TAB_LABELS, type WorkspaceTab } from "./workspace-tabs-state";

// Tabler's git-pull-request geometry, rasterized at 1x/2x/3x for UIKit template images.
const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");
const COMPOSE_TAB = "compose";
const TABS = ["chats", "pullRequests"] as const;

/** Retain each native controller tree; removing its root can leave RNS's stack empty. */
function RetainedWorkspaceTab(props: {
  readonly tab: WorkspaceTab;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const workspace = useWorkspaceTabs();
  const { isTabActive } = workspace;
  const isActive = useCallback(() => isTabActive(props.tab), [isTabActive, props.tab]);
  const activity = useMemo(() => ({ active: props.active, isActive }), [props.active, isActive]);
  const [content, setContent] = useState(
    props.active ? { workspace, children: props.children } : null,
  );
  if (props.active && (content?.workspace !== workspace || content?.children !== props.children))
    setContent({ workspace, children: props.children });
  return content ? (
    <NativeWorkspaceTabActivityContext value={activity}>
      <WorkspaceTabsContext value={content.workspace}>{content.children}</WorkspaceTabsContext>
    </NativeWorkspaceTabActivityContext>
  ) : null;
}

/**
 * UIKit retains both controller trees and shows the system tab bar for the
 * current size class. On a phone, compose is UIKit's own search-role tab,
 * detached like Photos' search button; it never becomes selected and opens
 * New Task instead. iPad composes from the empty detail or the conversation
 * header (WorkspaceEmptyDetail, useThreadHeaderOptions).
 */
export function WorkspaceNativeTabs(props: {
  readonly children: ReactNode;
  readonly hidden: boolean;
  readonly onSelect: () => void;
  readonly onNewTask: () => void;
}) {
  const workspace = useWorkspaceTabs();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const [provenance, setProvenance] = useState(0);
  const selectedTab = workspace.state.selectedTab;
  const request = useMemo(
    () => ({ selectedScreenKey: selectedTab, baseProvenance: provenance }),
    [selectedTab, provenance],
  );
  return (
    <View style={{ flex: 1 }}>
      <Tabs.Host
        navStateRequest={request}
        tabBarHidden={props.hidden || sidebarTabs}
        ios={{ tabBarControllerMode: "tabBar", tabBarMinimizeBehavior: "never" }}
        onTabSelectionPrevented={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionPreventedEvent>) => {
          if (nativeEvent.preventedScreenKey === COMPOSE_TAB) props.onNewTask();
        }}
        onTabSelectionRejected={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionRejectedEvent>) => {
          setProvenance(nativeEvent.provenance);
        }}
        onTabSelected={({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
          const tab = nativeEvent.selectedScreenKey;
          if (tab !== "chats" && tab !== "pullRequests") return;
          setProvenance(nativeEvent.provenance);
          if (nativeEvent.actionOrigin === "programmatic-js" || tab === selectedTab) return;
          Keyboard.dismiss();
          props.onSelect();
          workspace.dispatch({ type: "select", tab });
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen
            key={tab}
            screenKey={tab}
            title={WORKSPACE_TAB_LABELS[tab]}
            tabBarItemAccessibilityLabel={WORKSPACE_TAB_LABELS[tab]}
            ios={{
              icon:
                tab === "chats"
                  ? { type: "sfSymbol", name: "text.bubble" }
                  : { type: "templateSource", templateSource: PULL_REQUEST_ICON },
              selectedIcon:
                tab === "chats" ? { type: "sfSymbol", name: "text.bubble.fill" } : undefined,
              overrideScrollViewContentInsetAdjustmentBehavior: false,
            }}
          >
            <RetainedWorkspaceTab tab={tab} active={selectedTab === tab}>
              {props.children}
            </RetainedWorkspaceTab>
          </Tabs.Screen>
        ))}
        {Platform.OS === "ios" && Platform.isPad ? null : (
          <Tabs.Screen
            key={COMPOSE_TAB}
            screenKey={COMPOSE_TAB}
            title="New session"
            tabBarItemAccessibilityLabel="New session"
            preventNativeSelection
            ios={{
              role: "search",
              // iOS 27 detaches a search tab only while it may activate search.
              automaticallyActivatesSearch: true,
              icon: { type: "sfSymbol", name: "square.and.pencil" },
            }}
          >
            <View />
          </Tabs.Screen>
        )}
      </Tabs.Host>
    </View>
  );
}
