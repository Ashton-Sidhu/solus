// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsScreen.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { ScreenScrollViewSurface } from "../../../components/ScreenScrollView";
import type { ScreenHeaderProps } from "../../../components/ScreenHeader.types";
import { ScreenHeader } from "../../../components/ScreenHeader";
import { MaterialScreenContent as SettingsScreenContent } from "../../../components/MaterialScreenContent";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<
    ScreenHeaderProps,
    "title" | "actions" | "trailing" | "menus" | "search"
  > & {
    readonly children: ReactNode;
    /** A native form sheet already owns its rounded outer frame. */
    readonly formSheet?: boolean;
    readonly workspaceRoot?: boolean;
  },
) {
  const navigation = useNavigation();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title={props.title}
        actions={props.actions}
        menus={props.menus}
        search={props.search}
        options={
          props.workspaceRoot
            ? {
                headerBackVisible: false,
                unstable_navigationItemStyle: "editor",
              }
            : undefined
        }
        trailing={Platform.OS === "android" ? props.trailing : undefined}
        sidebar={false}
        onBack={props.workspaceRoot ? undefined : () => navigation.goBack()}
        hideBottomBorder={!props.formSheet}
      />
      <ScreenScrollViewSurface value="bg-sheet">
        {props.formSheet ? (
          props.children
        ) : (
          <SettingsScreenContent>{props.children}</SettingsScreenContent>
        )}
      </ScreenScrollViewSurface>
    </View>
  );
}
