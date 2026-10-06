// Adapted from T3 Code apps/mobile/src/features/threads/useThreadHeaderOptions.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { Platform } from "react-native";

import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import type { RootStackParamList } from "../../navigation/routes";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ThreadHeaderTitle } from "./ThreadHeaderTitle";
import { threadTitleMaxWidth } from "../../lib/layout";

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
  /** The project root whose favicon stands before the project name; null for a chat. */
  readonly faviconRoot: string | null;
  /** Width of the pane the header spans. */
  readonly headerWidth: number;
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
  const mark = faviconRoot ? (
    <ProjectFavicon
      environmentId={hostId}
      size={13}
      projectTitle={faviconRoot.split(/[\\/]/).at(-1) || faviconRoot}
      workspaceRoot={faviconRoot}
    />
  ) : null;
  const titleMaxWidth = threadTitleMaxWidth(props.headerWidth, actions.length, canGoBack);
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
    unstable_headerSubtitle: subtitle,
    contentStyle: undefined,
    // UIKit's title and subtitle are strings only; the favicon needs a title view.
    ...(mark && Platform.OS === "ios"
      ? {
          headerTitle: () => (
            <ThreadHeaderTitle
              title={props.title}
              subtitle={subtitle}
              mark={mark}
              maxWidth={titleMaxWidth}
              heavy={props.usesNativeHeaderGlass}
            />
          ),
          unstable_headerSubtitle: undefined,
        }
      : undefined),
  };
  return {
    options,
    // A title view is a function whose source never changes: re-apply it when what it shows does.
    optionsVersion: [props.title, subtitle, faviconRoot, titleMaxWidth],
    subtitleLeading: mark,
    actions,
    onBack: () => {
      // Read the history at press time: it changes without re-rendering this screen.
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.dispatch(StackActions.replace("Home"));
    },
  };
}
