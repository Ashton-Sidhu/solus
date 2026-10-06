// Adapted from T3 Code apps/mobile/src/features/threads/ThreadRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { isChat } from "@solus/contracts/chat";
import type { SessionRecord } from "@solus/contracts/types";
import { useEffect, useMemo } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import type { LastRoute } from "../../app/solus-app";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { ScreenHeader } from "../../components/ScreenHeader";
import { deriveLayout } from "../../lib/layout";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import type { RootStackParamList, ScreenProps } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import { newThreadTarget } from "./new-thread-targets";
import { threadKey } from "./thread-directory";
import { threadFaviconRoot, threadProjectPath } from "./threadListV2";
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
  };
}

function lastFolderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
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
        title="Thread unavailable"
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
  const started = newThreadTarget(hostId, sessionId);
  const target: { record: ConversationRecord } | { newSession: NonNullable<typeof started> } | null = shell
    ? { record: recordOf(shell.record) }
    : restored
      ? { record: restored }
      : started
        ? { newSession: started }
        : null;
  // One store per conversation, keyed by session id: a lookup after the first
  // call, and the same store when the directory's record arrives later.
  const store = target ? app.conversation(hostId, target) : null;

  // A thread the directory has not read yet: read this host's sessions.
  useEffect(() => {
    if (!shell && hostState.kind === "idle") void app.threads.load(hostId);
  }, [app, hostId, hostState.kind, shell]);

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
      faviconRoot={threadFaviconRoot(
        "record" in target
          ? (shell?.record ?? target.record)
          : { projectPath, cwd: target.newSession.workingDirectory },
        null,
      )}
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
  readonly faviconRoot: string | null;
}) {
  const app = useApp();
  const { store, hostId } = props;
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const runTitle = useListened(store.meta, () => store.controller.run.title);
  const hasRows = useListened(store.order, () => store.orderSnapshot().length > 0);
  const connectionState = useListened(
    app.connections.changes,
    () => app.connections.state(hostId)?.phase ?? null,
  );
  const window = useWindowDimensions();
  const layout = deriveLayout(window);
  const chat = isChat(props.projectPath);
  const title = props.shellTitle || runTitle || "New thread";
  const headerSubtitle = [chat ? null : lastFolderName(props.projectPath), props.hostLabel]
    .filter(Boolean)
    .join(" · ");
  const header = useThreadHeaderOptions({
    title,
    subtitle: headerSubtitle,
    usesNativeHeaderGlass: NATIVE_LIQUID_GLASS_SUPPORTED,
    hostId,
    projectPath: chat || !props.projectPath ? null : props.projectPath,
    faviconRoot: props.faviconRoot,
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
      <ScreenHeader
        title={title}
        subtitle={headerSubtitle}
        sidebar={false}
        options={header.options}
        optionsVersion={header.optionsVersion}
        subtitleLeading={header.subtitleLeading}
        onBack={layout.usesSplitView ? undefined : header.onBack}
        actions={header.actions}
        groupActions
        hideBottomBorder
      />
      <View className="flex-1 bg-screen android:overflow-hidden android:rounded-t-[28px] android:bg-thread-canvas">
        {meta.phase.kind === "error" && !hasRows ? (
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
            connectionState={connectionState}
            historyControls={historyControls}
            layoutVariant={layout.variant}
            usesAutomaticContentInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
            onReconnectHost={() => app.connections.retry(hostId)}
          />
        )}
      </View>
    </>
  );
}
