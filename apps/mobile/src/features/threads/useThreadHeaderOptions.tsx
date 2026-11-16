// Adapted from T3 Code features/threads/ThreadHeader.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";

import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import type { RootStackParamList } from "../../navigation/routes";

/** T3's native title and Files control; previews belong above the composer. */
export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly hostId: string;
  readonly projectPath: string | null;
}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hostId, projectPath } = props;
  const actions = useMemo<ReadonlyArray<ScreenHeaderAction>>(
    () =>
      projectPath
        ? [
            {
              accessibilityLabel: "Open files",
              icon: "folder",
              onPress: () =>
                navigation.navigate("Files", {
                  hostId,
                  projectPath,
                  folderPath: "",
                }),
            },
          ]
        : [],
    [hostId, navigation, projectPath],
  );
  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: props.title,
    title: props.title,
    headerBackVisible: navigation.canGoBack(),
    unstable_headerSubtitle: props.usesNativeHeaderGlass
      ? props.subtitle
      : undefined,
    contentStyle: undefined,
  };
  return {
    options,
    actions,
    onCompose: () =>
      navigation.navigate(
        "NewTask",
        projectPath ? { hostId, projectPath } : { hostId },
      ),
    onBack: () => {
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.dispatch(StackActions.replace("Home"));
    },
  };
}
