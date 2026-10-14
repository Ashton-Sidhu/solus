// Adapted from T3 Code apps/mobile/src/features/threads/useThreadHeaderOptions.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { Platform, View } from "react-native";

import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import type { RootStackParamList } from "../../navigation/routes";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";

// Bar geometry the title view must clear: the Back button on the left, the
// action group on the right, and the bar's margins.
const BACK_ITEM_WIDTH = 68;
const ACTION_GROUP_INSET = 32;
const HEADER_ACTION_WIDTH = 53;

/**
 * The thread header: title and subtitle, the native back button (a cold
 * start with no history gets a way to the thread list instead), and the
 * header actions that have Solus counterparts — the project's files, the
 * host's pull requests (only when the session has a linked pull request), your
 * notifications, and a new thread in the same project. T3's terminal,
 * git, and merge-back controls have no Solus equivalent on the phone.
 */
export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  /** The width of the column the thread shows in: the window on a phone, the detail column on iPad. */
  readonly columnWidth: number;
  readonly usesNativeHeaderGlass: boolean;
  readonly hostId: string;
  /** The project folder, or null for a chat, which has no files to browse. */
  readonly projectPath: string | null;
  /** The project root whose favicon the header shows; null for a chat. */
  readonly faviconRoot: string | null;
  /** Whether a pull request is linked to the session; without one the pull requests action is hidden. */
  readonly hasLinkedPullRequests: boolean;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hostId, projectPath, hasLinkedPullRequests } = props;
  const actions = useMemo<ReadonlyArray<ScreenHeaderAction>>(() => {
    const items: ScreenHeaderAction[] = [];
    if (projectPath) {
      items.push({
        accessibilityLabel: "Open files",
        icon: "folder",
        onPress: () => navigation.navigate("Files", { hostId, projectPath, folderPath: "" }),
      });
    }
    if (hasLinkedPullRequests) {
      items.push({
        accessibilityLabel: "Open pull requests",
        icon: "arrow.triangle.pull",
        // The host's pull requests are the Pull Requests tab narrowed to it.
        onPress: () => navigation.popTo("Home", { tab: "pullRequests", hostId }),
      });
    }
    items.push({
      accessibilityLabel: "Open notifications",
      icon: "bell.badge",
      onPress: () => navigation.navigate("Notifications"),
    });
    // A chat has no project to keep, so its new thread starts at the project choice.
    items.push({
      accessibilityLabel: "New session",
      icon: "square.and.pencil",
      onPress: () => navigation.navigate("NewTask", projectPath ? { hostId, projectPath } : { hostId }),
    });
    return items;
  }, [hasLinkedPullRequests, hostId, navigation, projectPath]);

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
  // UIKit's subtitle is a plain string, so a project thread draws its own
  // title view to put the favicon beside the project name. It is as wide as
  // the space between the bar items; UIKit moves it off centre to fit there.
  // On iPad the title sits at the leading edge, beside the Back button.
  const customTitle = Boolean(faviconRoot && subtitle && Platform.OS === "ios");
  const titleWidth =
    props.columnWidth - BACK_ITEM_WIDTH - ACTION_GROUP_INSET - actions.length * HEADER_ACTION_WIDTH;
  const titleAlignment = Platform.OS === "ios" && Platform.isPad ? "items-start" : "items-center";
  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: customTitle
      ? () => (
          <View style={{ width: Math.max(titleWidth, 0) }} className={titleAlignment}>
            <Text numberOfLines={1} className="text-[17px] font-extrabold text-foreground">
              {props.title}
            </Text>
            <View className="max-w-full flex-row items-center gap-1">
              {favicon(13)}
              <Text numberOfLines={1} className="min-w-0 flex-shrink text-[13px] text-foreground-muted">
                {subtitle}
              </Text>
            </View>
          </View>
        )
      : props.title,
    headerTitleStyle: props.usesNativeHeaderGlass
      ? {
          fontSize: 17,
          fontWeight: "800",
        }
      : undefined,
    title: props.title,
    headerBackVisible: canGoBack,
    // Without a favicon, title and subtitle stay UIKit's own strings, as T3's
    // header: the bar lays them out between its items and truncates them
    // before the action group on any width.
    unstable_headerSubtitle: customTitle ? undefined : subtitle,
    contentStyle: undefined,
  };
  return {
    options,
    // The title view is a function whose source never changes: re-apply it when its content does.
    optionsVersion: [props.title, subtitle, faviconRoot, titleWidth],
    subtitleLeading: favicon(13),
    actions,
    onBack: () => {
      // Read the history at press time: it changes without re-rendering this screen.
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.dispatch(StackActions.replace("Home"));
    },
  };
}
