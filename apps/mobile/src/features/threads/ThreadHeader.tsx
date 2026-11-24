import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
  type ThreadGitMenuProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps | (ThreadGitMenuProps & { readonly canOpenFiles: boolean });
  readonly onReturnToThread?: () => void;
  readonly onOpenRunningServers?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = "canOpenTerminal" in props.gitControls ? threadTerminalMenu(props.gitControls, m) : null;
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return <ThreadNavigationHeader {...props} actions={actions} menus={menus} />;
}

export function ThreadNavigationHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly draft?: boolean;
  readonly onReturnToThread?: () => void;
  readonly onOpenRunningServers?: () => void;
  readonly actions?: AppBarAction[];
  readonly menus?: AppBarMenu[];
}) {
  const gt = useGT();
  const goBack = useWorkspaceBackNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={props.onOpenRunningServers ? [
        ...(props.actions ?? []),
        { accessibilityLabel: gt("Running servers"), icon: "server.rack", onPress: props.onOpenRunningServers },
      ] : props.actions}
      menus={props.menus}
      hideBottomBorder
    />
  );
}
