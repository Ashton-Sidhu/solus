// Adapted from T3 Code apps/mobile/src/features/threads/useThreadHeaderOptions.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { Platform, View } from "react-native";

import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import type { RootStackParamList } from "../../navigation/routes";
import { ProjectFavicon } from "../../components/ProjectFavicon";

/**
 * The thread header: title and subtitle, the native back button (a cold
 * start with no history gets a way to the thread list instead), and the
 * header actions that have Solus counterparts — the project's files, the
 * host's pull requests, and a new thread in the same project. T3's terminal,
 * git, and merge-back controls have no Solus equivalent on the phone.
 */
export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly hostId: string;
  /** The project folder, or null for a chat, which has no files to browse. */
  readonly projectPath: string | null;
  /** The project root whose favicon the header shows; null for a chat. */
  readonly faviconRoot: string | null;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hostId, projectPath } = props;
  const actions = useMemo<ReadonlyArray<ScreenHeaderAction>>(() => {
    const items: ScreenHeaderAction[] = [];
    if (projectPath) {
      items.push({
        accessibilityLabel: "Open files",
        icon: "folder",
        onPress: () => navigation.navigate("Files", { hostId, projectPath, folderPath: "" }),
      });
    }
    items.push({
      accessibilityLabel: "Open pull requests",
      icon: "arrow.triangle.pull",
      onPress: () => navigation.navigate("PullRequests", { hostId }),
    });
    // A chat has no project to keep, so its new thread starts at the project choice.
    items.push({
      accessibilityLabel: "New thread",
      icon: "square.and.pencil",
      onPress: () => navigation.navigate("NewTask", projectPath ? { hostId, projectPath } : { hostId }),
    });
    return items;
  }, [hostId, navigation, projectPath]);

  // Deep links and cold starts land with Thread as the only route, where the
  // native back button does not render; Home is the way out.
  const canGoBack = navigation.canGoBack();
  const { faviconRoot } = props;
  const projectTitle = faviconRoot ? faviconRoot.split(/[\\/]/).at(-1) || faviconRoot : "";
  const favicon = (size: number) =>
    faviconRoot ? (
      <ProjectFavicon environmentId={hostId} size={size} projectTitle={projectTitle} workspaceRoot={faviconRoot} />
    ) : null;
  const subtitle = props.usesNativeHeaderGlass ? props.subtitle : undefined;
  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: props.title,
    headerTitleStyle: props.usesNativeHeaderGlass
      ? {
          fontSize: 17,
          fontWeight: "800",
        }
      : undefined,
    title: props.title,
    headerBackVisible: canGoBack,
    // Title and subtitle stay UIKit's own strings, as T3's header: the bar
    // lays them out between its items and truncates them before the action
    // group on any width. A custom title view keeps its own size and is
    // centred over the items instead.
    unstable_headerSubtitle: subtitle,
    contentStyle: undefined,
    // The favicon is a left bar item beside Back, without a glass background.
    // With Back visible, UIKit keeps both (`leftItemsSupplementBackButton`).
    ...(faviconRoot && Platform.OS === "ios"
      ? {
          unstable_headerLeftItems: () => [
            {
              type: "custom" as const,
              identifier: "thread-project-favicon",
              hidesSharedBackground: true,
              element: (
                // Decorative: the subtitle names the project.
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  {favicon(20)}
                </View>
              ),
            },
          ],
        }
      : undefined),
  };
  return {
    options,
    // The left item is a function whose source never changes: re-apply it when the project does.
    optionsVersion: [props.title, subtitle, faviconRoot],
    subtitleLeading: favicon(13),
    actions,
    onBack: () => {
      // Read the history at press time: it changes without re-rendering this screen.
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.dispatch(StackActions.replace("Home"));
    },
  };
}
