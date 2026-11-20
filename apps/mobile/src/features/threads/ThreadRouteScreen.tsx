// Adapted from T3 Code apps/mobile/src/features/threads/ThreadRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { isChat } from "@solus/contracts/chat";
import { hostPathBaseName } from "@solus/contracts/host-path";
import type { SessionRecord } from "@solus/contracts/types";
import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import type { LastRoute } from "../../app/solus-app";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { ScreenHeader } from "../../components/ScreenHeader";
import { deriveLayout } from "../../lib/layout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import type { RootStackParamList, ScreenProps } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import { newThreadTarget, type NewThreadTarget } from "./new-thread-targets";
import { threadKey } from "./thread-directory";
import { threadProjectPath } from "./threadListV2";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import type { ThreadContentPresentation, ThreadFeedHistoryControls } from "./ThreadFeed";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";

type ConversationRecord = NonNullable<LastRoute["record"]>;

function recordOf(record: SessionRecord): ConversationRecord {
  return {
    sessionId: record.sessionId,
    provider: record.provider,
    projectPath: record.projectPath,
    cwd: record.cwd,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    title: record.title,
    customTitle: record.customTitle,
    role: record.role,
  };
}

type ThreadTarget = { record: ConversationRecord } | { newSession: NewThreadTarget };

/** What the thread opens, from the first source that knows the session. */
function threadTarget(
  listed: SessionRecord | undefined,
  restored: ConversationRecord | null,
  started: NewThreadTarget | null,
  moved: ConversationStore | null,
): ThreadTarget | null {
  if (listed) return { record: recordOf(listed) };
  if (restored) return { record: restored };
  if (started) return { newSession: started };
  const record = moved?.controller.target.record;
  return record ? { record } : null;
}

function lastFolderName(path: string): string {
  return hostPathBaseName(path) || path;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
  readonly title?: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title={props.title ?? "Thread unavailable"}
        detail={props.detail}
        actionLabel={props.actionLabel}
        onAction={props.onAction}
      />
    </ScrollView>
  );
}

/**
 * One session, as T3's thread screen. The session comes from the thread
 * directory, else from the route this launch restored, else from the
 * new-task sheet that just started it; until one of them knows it, the host
 * is asked again.
 */
export function ThreadRouteScreen({ route }: ScreenProps<"Thread">) {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hostId, sessionId } = route.params;
  const shell = useListened(app.threads.changes, () => app.threads.thread(hostId, sessionId));
  const hostState = useListened(app.threads.changes, () => app.threads.stateOf(hostId));
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  const restored = useMemo(() => {
    const last = app.lastRoute();
    return last?.hostId === hostId && last.record?.sessionId === sessionId ? last.record : null;
  }, [app, hostId, sessionId]);
  const target = threadTarget(
    shell?.record,
    restored,
    newThreadTarget(hostId, sessionId),
    // A session the person just chose this host for: the host lists it after its sync.
    app.openConversation(hostId, sessionId),
  );
  // One store per conversation, keyed by session id: a lookup after the first
  // call, and the same store when the directory's record arrives later.
  const store = target ? app.conversation(hostId, target) : null;

  // A thread the directory has not read yet: read this host's sessions.
  useEffect(() => {
    if (!shell && hostState.kind === "idle") void app.threads.load(hostId);
  }, [app, hostId, hostState.kind, shell]);

  // The next prompt runs on another host: the thread opens there at once.
  const chooseHost = useCallback((nextHostId: string) => {
    if (!store || !app.moveConversation(store, nextHostId)) return;
    navigation.setParams({ hostId: nextHostId });
  }, [app, navigation, store]);

  // The thread is the place to come back to on the next launch.
  const record = shell?.record ?? null;
  useEffect(() => {
    if (record) app.rememberRoute({ hostId, projectPath: record.projectPath, record: recordOf(record) });
  }, [app, hostId, record]);

  if (!host) {
    return (
      <ThreadUnavailableScreen
        detail="This host is no longer on this device."
        actionLabel="Manage hosts"
        onAction={() => navigation.navigate("Hosts")}
      />
    );
  }
  if (!target) {
    if (hostState.kind === "idle" || hostState.kind === "loading") return <OpeningThreadLoadingScreen />;
    return (
      <ThreadUnavailableScreen
        detail={
          hostState.kind === "error"
            ? `This host's sessions could not be read: ${hostState.message}`
            : "This session is not on the host any more."
        }
        actionLabel="Try again"
        onAction={() => void app.threads.load(hostId)}
      />
    );
  }
  if (!store) {
    return (
      <ThreadUnavailableScreen
        detail="This host cannot be reached now. Check its state in Hosts."
        actionLabel="Manage hosts"
        onAction={() => navigation.navigate("Hosts")}
      />
    );
  }
  // The project the header names and opens files in, not the provider's
  // storage folder a Claude session lists as its `projectPath`.
  const projectPath =
    "record" in target
      ? threadProjectPath(shell?.record ?? target.record)
      : target.newSession.workingDirectory;
  return (
    <ThreadRouteContent
      store={store}
      hostId={hostId}
      sessionId={sessionId}
      hostLabel={host.label}
      shellTitle={shell ? shell.record.customTitle || shell.record.title || shell.record.slug : null}
      projectPath={projectPath}
      onChooseHost={"record" in target ? chooseHost : undefined}
    />
  );
}

function ThreadRouteContent(props: {
  readonly store: ConversationStore;
  readonly hostId: string;
  readonly sessionId: string;
  readonly hostLabel: string;
  readonly shellTitle: string | null;
  readonly projectPath: string;
  readonly onChooseHost?: (hostId: string) => void;
}) {
  const app = useApp();
  const { store, hostId } = props;
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const runTitle = useListened(store.meta, () => store.controller.run.title);
  const hasRows = useListened(store.order, () => store.orderSnapshot().length > 0);
  const hostReadiness = useListened(app.connections.changes, () => app.connections.readiness(hostId));
  const window = useWindowDimensions();
  const layout = deriveLayout(window);
  const chat = isChat(props.projectPath);
  const title = props.shellTitle || runTitle || "New session";
  // Where the conversation names its host: the host with the newest turn, when it is not this one.
  const lastRanOn = useListened(app.runHosts.changes, () => {
    const newest = app.runHosts.newestHostOf(props.sessionId, hostId);
    return newest && newest !== hostId ? app.registry.host(newest)?.label ?? null : null;
  });
  const headerSubtitle = [chat ? null : lastFolderName(props.projectPath), lastRanOn ? `Last ran on ${lastRanOn}` : props.hostLabel]
    .filter(Boolean)
    .join(" · ");
  const header = useThreadHeaderOptions({
    title,
    subtitle: headerSubtitle,
    usesNativeHeaderGlass: NATIVE_LIQUID_GLASS_SUPPORTED,
    hostId,
    projectPath: chat || !props.projectPath ? null : props.projectPath,
  });

  const historyControls = useMemo<ThreadFeedHistoryControls | undefined>(
    () =>
      meta.hasOlder
        ? {
            hasMoreHistory: true,
            loading: meta.loadingOlder,
            error: null,
            onLoadEarlier: () => void store.controller.loadOlder(),
          }
        : undefined,
    [meta.hasOlder, meta.loadingOlder, store],
  );

  const contentPresentation: ThreadContentPresentation =
    meta.phase.kind === "error" && !hasRows
      ? {
          kind: "unavailable",
          title: "The conversation could not be opened",
          detail: meta.phase.message,
        }
      : meta.phase.kind === "loading" && !hasRows
        ? { kind: "loading" }
        : { kind: "ready" };

  return (
    <>
      {layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button accessibilityLabel="New session" icon="square.and.pencil" onPress={header.onCompose} />
        </NativeHeaderToolbar>
      ) : null}
      <ScreenHeader
        title={title}
        subtitle={headerSubtitle}
        sidebar={false}
        options={header.options}
        onBack={layout.usesSplitView ? undefined : header.onBack}
        actions={header.actions}
        groupActions
        hideBottomBorder
      />
      <View
        className="flex-1 bg-screen android:overflow-hidden android:rounded-t-[28px] android:bg-thread-canvas"
      >
        {meta.phase.kind === "error" && meta.phase.noAccess === true ? (
          // The session is named, never the host: the host answered, and only
          // its owner can give access (docs/plans/shared-with-you.md §4.5).
          // This app does not read people's names, so the owner is not named.
          <ThreadUnavailableScreen
            title="You don't have access to this session"
            detail={
              props.shellTitle || runTitle
                ? `Ask the owner of ${props.shellTitle || runTitle} to share it with you.`
                : "Ask its owner to share it with you."
            }
            actionLabel="Try again"
            onAction={() => void store.controller.load()}
          />
        ) : meta.phase.kind === "error" && !hasRows ? (
          <ThreadUnavailableScreen
            detail={`This conversation could not be opened: ${meta.phase.message}`}
            actionLabel="Try again"
            onAction={() => void store.controller.load()}
          />
        ) : (
          <ThreadDetailScreen
            store={store}
            meta={meta}
            threadKey={threadKey(hostId, props.sessionId)}
            draftKey={props.sessionId}
            contentPresentation={contentPresentation}
            hostLabel={props.hostLabel}
            hostReadiness={hostReadiness}
            historyControls={historyControls}
            startedBy={meta.startedBy}
            layoutVariant={layout.variant}
            usesAutomaticContentInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
            onChooseHost={props.onChooseHost}
          />
        )}
      </View>
    </>
  );
}
