import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { DraftWorkspaceControls } from "../../solus/DraftWorkspaceControls";
import { AppProvider } from "@solus-mobile/app/app-context";
import { useGT } from "gt-react-native";
import { solus } from "../../solus/runtime";
import { useThreadSession } from "../../solus/use-thread-session";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { useThreadScreenData } from "../../solus/use-thread-screen-data";
import { useCheckoutGitControls } from "../../solus/CheckoutGit";
import { isChat } from "@solus/contracts/chat";
import { useSessionHasRunningServers } from "../running-servers/use-session-has-running-servers";
import { ThreadHeader, ThreadNavigationHeader } from "./ThreadHeader";
import { DraftContextControls, DraftEnvironmentControl } from "./DraftEnvironmentControl";
import { draftHeroContent, SHORT_DRAFT_VIEWPORT_HEIGHT } from "./NewTaskHero";
import { TurnDiffReader } from "../../solus/turn-diff-context";
import { Inspector, useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { ThreadScreenBinding, ThreadScreenHost } from "./ThreadScreenHost";
import { InspectorContentScope, ThreadInspectorPreview } from "./thread-inspector-preview";
import { ThreadInspectorHeader, type ThreadInspectorPresentation } from "./thread-inspector-header";
import type { ThreadInspectorTarget } from "./thread-inspector-navigation";
import { submittedThreadParams, type NewTaskDraftRouteParams } from "./thread-route-state";
import {
  InspectorHeaderShownContext,
  OpeningThreadLoadingScreen,
  ThreadUnavailableScreen,
} from "./ThreadRouteStateScreens";

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly draft?: NewTaskDraftRouteParams;
  readonly inspector?: ThreadInspectorTarget;
  readonly prompt?: string | string[];
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly inspectorPresentation?: ThreadInspectorPresentation;
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: () => ReactNode;
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const draft = props.route.params?.draft;
  const navigation = useNavigation();
  const needsProject = !!draft && (!draft.environmentId || !draft.projectId);
  useEffect(() => {
    if (needsProject)
      navigation.dispatch(
        StackActions.replace("NewTaskProject", {
          draftId: draft?.draftId,
          incomingShareId: draft?.incomingShareId,
        }),
      );
  }, [needsProject, navigation, draft]);
  if (needsProject)
    return (
      <ThreadScreenHost>
        <OpeningThreadLoadingScreen />
      </ThreadScreenHost>
    );
  return <ThreadRouteContent {...props} />;
}

type ReadySession = Extract<ReturnType<typeof useThreadSession>, { kind: "ready" }>;

function ThreadRouteContent(props: ThreadRouteScreenProps) {
  const session = useThreadSession(props.route.params ?? {});
  const route = props.route.params;
  const navigation = useNavigation();
  const goBack = useAndroidWorkspaceBack();
  const gt = useGT();
  const savedHost =
    session.kind === "ready" && session.isDraft && session.saved ? session.hostId : null;
  const savedThread = session.kind === "ready" ? session.id : null;
  // Restore a draft route that the host already saved before the app last closed.
  useEffect(() => {
    if (savedHost && savedThread)
      navigation.dispatch(CommonActions.setParams(submittedThreadParams(savedHost, savedThread)));
  }, [savedHost, savedThread, navigation]);

  return (
    <AppProvider app={solus}>
      <TurnDiffReader.Provider
        value={session.kind === "ready" ? session.readTurnDiff : null}
      >
        {(route?.inspector || props.renderInspector) && !props.inspectorPresentation ? (
          <Inspector
            revealKey={JSON.stringify([route?.environmentId, route?.threadId, route?.inspector])}
            content={{
              active: "files",
              resetKeys: [route?.environmentId, route?.threadId],
              panes: [{ key: "files", render: () => route?.inspector ? (
                <ThreadInspectorPreview target={route.inspector} renderThread={thread => <ThreadRouteScreen {...thread}/>}
                  onClose={() => navigation.dispatch(CommonActions.setParams({inspector: undefined}))}
                  onOpen={inspector => navigation.dispatch(CommonActions.setParams({inspector}))}/>
              ) : props.renderInspector?.() }],
            }}
          />
        ) : null}
        <ThreadScreenHost>
          {session.kind === "ready" ? (
            <ThreadContent
              key={JSON.stringify([session.hostId, session.id])}
              session={session}
              route={props}
            />
          ) : (
            <InspectorHeaderShownContext value={props.inspectorPresentation !== undefined}>
              {props.inspectorPresentation ? (
                <ThreadInspectorHeader title={gt("Thread")} {...props.inspectorPresentation} />
              ) : null}
              {session.kind === "loading" ? (
                <OpeningThreadLoadingScreen />
              ) : (
                <ThreadUnavailableScreen
                  detail={session.detail}
                  actionLabel={
                    session.recovery?.kind === "reconnect"
                      ? gt("Reconnect environment")
                      : session.recovery?.kind === "retry"
                        ? gt("Try again")
                        : session.hostId
                          ? gt("Back to sessions")
                          : gt("Connect an environment")
                  }
                  onAction={
                    session.recovery?.run ??
                    (session.hostId ? goBack : () => navigation.navigate("SettingsEnvironmentNew"))
                  }
                />
              )}
            </InspectorHeaderShownContext>
          )}
        </ThreadScreenHost>
      </TurnDiffReader.Provider>
    </AppProvider>
  );
}

function ThreadContent({
  session,
  route,
}: {
  session: ReadySession;
  route: ThreadRouteScreenProps;
}) {
  const { binding, draft, header, sessionFolders } = useThreadScreenData(session);
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const gt = useGT();
  const hasServers = useSessionHasRunningServers(session.hostId, session.id, header.cwd, sessionFolders, !draft && !route.inspectorPresentation);
  const onOpenRunningServers = hasServers ? () => navigation.navigate("ThreadRunningServers", {
    environmentId: session.hostId,
    threadId: session.id,
  }) : undefined;
  const environmentControl = draft ? (
    <DraftEnvironmentControl
      connectionState={draft.connectionState}
      label={draft.environmentLabel}
      machineKind="server"
      disabled={draft.disabled}
      onChooseEnvironment={draft.chooseEnvironment}
    />
  ) : null;
  return (
    <ThreadScreenBinding
      {...binding}
      layoutVariant={layout.variant}
      draftMode={
        draft
          ? {
              editorRef: draft.editorRef,
              interactionLocked: draft.disabled,
              sendBlockedReason: null,
              content: draftHeroContent({ ...draft, environmentControl }),
              // T3's draft controls: the context pickers when the hero has no room, then the workspace row.
              controls: (height) => (
                <>
                  {height < SHORT_DRAFT_VIEWPORT_HEIGHT ? (
                    <DraftContextControls
                      projectLabel={draft.scratch ? gt("No project") : draft.title}
                      onChooseProject={draft.chooseProject}
                      connectionState={draft.connectionState}
                      label={draft.environmentLabel}
                      machineKind="server"
                      disabled={draft.disabled}
                      onChooseEnvironment={draft.chooseEnvironment}
                    />
                  ) : null}
                  {draft.scratch ? null : (
                    <DraftWorkspaceControls store={session.store} disabled={draft.disabled} draftKey={session.draftKey} />
                  )}
                </>
              ),
            }
          : undefined
      }
      header={
        route.inspectorPresentation ? (
          <ThreadInspectorHeader
            title={header.title || gt("Thread")}
            {...route.inspectorPresentation}
          />
        ) : !header.cwd || header.cwd === "~" || isChat(header.cwd) ? (
          <ThreadNavigationHeader {...header} onReturnToThread={route.onReturnToThread} onOpenRunningServers={onOpenRunningServers} />
        ) : (
          <ProjectThreadHeader {...header} onReturnToThread={route.onReturnToThread} onOpenRunningServers={onOpenRunningServers} />
        )
      }
    />
  );
}

function ProjectThreadHeader(
  props: ReturnType<typeof useThreadScreenData>["header"] & {
    onReturnToThread?: () => void;
    onOpenRunningServers?: () => void;
  },
) {
  const navigation = useNavigation();
  const gitControls = useCheckoutGitControls(props.controller, props.cwd, props.draft);
  return (
    <ThreadHeader
      {...props}
      hasThreadCwd
      inspectorMode={null}
      gitControls={{ ...gitControls, draftKey: props.draftKey }}
      onOpenFilesInspector={() => {
        const target = {
          environmentId: gitControls.environmentId,
          cwd: props.cwd,
          projectName: props.projectName,
        };
        if (props.draft) navigation.navigate("NewTaskFiles", target);
        else navigation.navigate("ThreadFiles", { ...target, threadId: gitControls.threadId });
      }}
    />
  );
}

export function FullscreenThreadRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
  }>,
) {
  const navigation = useNavigation();
  return (
    <InspectorContentScope>
      <ThreadRouteScreen
        route={props.route}
        inspectorPresentation={{ onClose: () => navigation.goBack() }}
      />
    </InspectorContentScope>
  );
}
