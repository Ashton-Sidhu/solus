// Adapted from T3 Code apps/mobile/src/features/workspace/WorkspaceToolbar.ios.tsx (MIT, see UPSTREAM.md).
import { useFocusEffect } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/**
 * The header of both workspace tabs on iOS: Settings and Search at the top
 * right, and a search field under the title while the person searches. On a
 * phone, compose is the tab bar's own button (WorkspaceNativeTabs); an iPad
 * keeps it at the right of the bottom toolbar.
 */
export function WorkspaceToolbar(props: {
  readonly onNewTask: () => void;
  readonly onOpenSettings: () => void;
}) {
  const workspace = useWorkspaceTabs();
  const { isTabActive, dispatch } = workspace;
  const { selectedTab, query, searchMode } = workspace.state;
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const iconColor = useUniwindTheme()["--color-icon"];
  const searchRef = useRef<SearchBarCommands>(null);
  const focusSearch = useCallback(() => {
    dispatch({ type: "search" });
    searchRef.current?.focus();
  }, [dispatch]);
  // A search field made again (focus or tab change) starts empty; give it the query back.
  const restoreSearch = useCallback(() => {
    if (isTabActive(selectedTab) && searchMode !== "resting") searchRef.current?.setText(query);
  }, [isTabActive, selectedTab, searchMode, query]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreSearch);
      return () => cancelAnimationFrame(frame);
    }, [restoreSearch]),
  );
  useEffect(() => {
    if (!tabActive) return;
    const frame = requestAnimationFrame(restoreSearch);
    return () => cancelAnimationFrame(frame);
  }, [restoreSearch, tabActive]);
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[selectedTab, searchMode]}
        options={{
          headerTintColor: iconColor,
          unstable_headerToolbarItems: () => [],
          headerSearchBarOptions:
            searchMode !== "resting"
              ? {
                  ref: searchRef,
                  autoFocus: searchMode === "active",
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked",
                  allowToolbarIntegration: false,
                  placeholder: selectedTab === "pullRequests" ? "Search pull requests" : "Search chats",
                  cancelButtonText: "✕",
                  onFocus: () => dispatch({ type: "search" }),
                  onBlur: () => dispatch({ type: "expand" }),
                  onSearchButtonPress: () => searchRef.current?.blur(),
                  onChangeText: ({ nativeEvent }) => dispatch({ type: "query", query: nativeEvent.text }),
                  onCancelButtonPress: () => dispatch({ type: "cancel" }),
                }
              : undefined,
        }}
      />
      {/* UIKit lays trailing items out from the edge inward. */}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Open settings"
          icon="gearshape"
          onPress={props.onOpenSettings}
        />
        <NativeHeaderToolbar.Button
          accessibilityLabel={selectedTab === "pullRequests" ? "Search pull requests" : "Search chats"}
          icon="magnifyingglass"
          onPress={focusSearch}
        />
      </NativeHeaderToolbar>
      {Platform.OS === "ios" && Platform.isPad ? (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Spacer flexible />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}
