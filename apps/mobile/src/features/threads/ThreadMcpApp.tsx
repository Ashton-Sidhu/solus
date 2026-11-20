// Adapted from T3 Code McpAppWebView.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostApi } from "@solus/client-core/host-api";
import type { McpAppHost, McpAppLiveCall } from "@solus/client-core/mcp-app-host";
import { mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
import { mcpAppLiveToolName, type McpAppCancelReason, type McpAppLiveDocument, type McpAppReference, type McpAppRequest, type McpAppSnapshot } from "@solus/contracts/mcp-apps";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { McpAppWebView } from "./McpAppWebView";
import { ThreadMcpLiveApp } from "./ThreadMcpLiveApp";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 320;
const CLOSED_APP: McpAppRead = { phase: "idle" };
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** A Solus integration tool: its call can show its MCP App while it runs. */
export function canShowLiveApp(item: TranscriptItem): boolean {
  return item.kind === "tool" && mcpAppLiveToolName(item.toolName) !== null;
}

/** An MCP App row of the feed: the app a tool call saved, or the live app of a Solus integration tool's call. */
export function ThreadMcpApp({ store, id }: { store: ConversationStore; id: string }) {
  const app = useApp();
  const item = useTranscriptItem(store, id);
  const api = app.connections.connection(store.controller.hostId)?.api;
  if (!api) return null;
  if (item?.kind === "tool") return <ThreadMcpLiveApp store={store} api={api} tool={item} />;
  if (item?.kind !== "mcp_app") return null;
  return <SavedMcpApp store={store} api={api} activityId={item.activityId} sessionId={item.sessionId} reference={item.app} />;
}

function SavedMcpApp(props: {
  readonly store: ConversationStore;
  readonly api: HostApi;
  readonly activityId: string;
  readonly sessionId: string;
  readonly reference: McpAppReference;
}) {
  const { store, api, activityId, sessionId, reference } = props;
  const apps = useMemo(() => mcpAppsFor(api), [api]);
  const live = useMemo(() => mcpAppLiveFor(api), [api]);
  const request = useMemo(() => ({ sessionId, activityId }), [sessionId, activityId]);
  const closedKeys = useMemo(() => (reference.toolUseId ? [activityId, reference.toolUseId] : [activityId]), [activityId, reference.toolUseId]);
  const [isClosed, setIsClosed] = useState(() => closedKeys.some((key) => store.closedMcpApps.has(key)));
  // While the live card of this call is mounted, it shows this app in its own frame.
  const readHeld = useCallback(() => live.isHeld(sessionId, reference.toolUseId), [live, sessionId, reference.toolUseId]);
  const isHeldLive = useSyncExternalStore(useCallback((listener) => live.subscribe(listener), [live]), readHeld, readHeld);
  useEffect(() => {
    if (isHeldLive && reference.toolUseId) live.handOver(sessionId, reference.toolUseId, activityId);
  }, [isHeldLive, live, sessionId, reference.toolUseId, activityId]);

  const isShown = !isClosed && !isHeldLive;
  const subscribe = useCallback((listener: () => void) => (isShown ? apps.subscribe(request, listener) : () => {}), [apps, request, isShown]);
  const read = useCallback(() => (isShown ? apps.read(request) : CLOSED_APP), [apps, request, isShown]);
  const state = useSyncExternalStore(subscribe, read, read);

  useEffect(() => {
    if (isShown) void apps.load(request);
  }, [apps, request, isShown]);

  if (isHeldLive) return null;
  if (!isClosed && state.phase !== "ready") {
    return (
      <View className="min-h-28 items-center justify-center gap-2">
        {state.phase === "error" ? (
          <>
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">{state.message}</Text>
            <Pressable accessibilityRole="button" onPress={() => void apps.load(request)} className="min-h-11 justify-center px-4">
              <Text className="text-sm text-foreground">Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading app" />
        )}
      </View>
    );
  }
  return (
    <McpAppCard
      store={store}
      api={api}
      request={request}
      title={reference.title}
      document={state.phase === "ready" ? state.snapshot : null}
      closedKeys={closedKeys}
      isClosed={isClosed}
      onClosedChange={setIsClosed}
    />
  );
}

/**
 * The card of one app, saved or live: the frame, its full-screen
 * presentation, and what the app gave the agent. `closedKeys` name the card in
 * the conversation store; the first one keeps its height.
 */
export function McpAppCard(props: {
  readonly store: ConversationStore;
  readonly api: HostApi;
  readonly request: McpAppRequest;
  readonly title: string;
  /** Null only while the card is closed and shows no frame. */
  readonly document: McpAppSnapshot | McpAppLiveDocument | null;
  readonly closedKeys: readonly string[];
  readonly isClosed: boolean;
  readonly onClosedChange: (isClosed: boolean) => void;
  readonly call?: McpAppLiveCall | null;
  readonly savedCall?: Pick<McpAppSnapshot, "toolInputJson" | "toolResultJson">;
  /** A live card's call gave no result. */
  readonly onCancelled?: (reason: McpAppCancelReason) => void;
}) {
  const { store, api, request, title, document, closedKeys, isClosed, onClosedChange } = props;
  const heightKey = closedKeys[0]!;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [height, setHeight] = useState(() => store.mcpAppHeights.get(heightKey) ?? INITIAL_HEIGHT);
  const [modelContext, setModelContext] = useState(() => (request.activityId ? store.mcpAppContexts.get(request.activityId) : undefined));
  const insets = useSafeAreaInsets();
  // The frame shown now: closing through it gives the app its teardown first.
  const host = useRef<McpAppHost | null>(null);

  // The conversation store keeps these across a remount of the row.
  const setClosed = (next: boolean) => {
    if (next) store.closedMcpApps.add(closedKeys[0]!);
    else for (const key of closedKeys) store.closedMcpApps.delete(key);
    onClosedChange(next);
  };
  const rememberHeight = (next: number) => {
    store.mcpAppHeights.set(heightKey, next);
    setHeight(next);
  };
  const rememberModelContext = (text: string) => {
    if (!request.activityId) return;
    if (text) store.mcpAppContexts.set(request.activityId, text);
    else store.mcpAppContexts.delete(request.activityId);
    setModelContext(text || undefined);
  };
  // Closing an app takes back what it gave the agent, so the agent never acts on an app the person no longer sees.
  const close = (cancelled?: McpAppCancelReason) => {
    setIsFullscreen(false);
    if (cancelled) {
      props.onCancelled?.(cancelled);
      return;
    }
    setClosed(true);
    if (request.activityId && store.mcpAppContexts.delete(request.activityId)) void api.mcpAppUpdateModelContext({ ...request, text: "" }).catch(() => {});
    setModelContext(undefined);
  };

  if (isClosed || !document) {
    return (
      <View style={{ height, marginBottom: 8 }} className="items-center justify-center gap-2 rounded-lg border border-border">
        <Text className="text-sm text-foreground-muted">The {title} app was closed</Text>
        <Pressable accessibilityRole="button" onPress={() => setClosed(false)} className="min-h-11 justify-center px-3">
          <Text className="text-sm text-foreground">Show app</Text>
        </Pressable>
      </View>
    );
  }

  // Inline and full screen are separate frames: each presentation starts its own app.
  const frame = (fullscreen: boolean) => (
    <McpAppWebView
      snapshot={document}
      call={props.call}
      savedCall={props.savedCall}
      api={api}
      request={request}
      store={store}
      title={title}
      hostRef={host}
      isFullscreen={fullscreen}
      safeAreaInsets={fullscreen ? { top: 0, right: insets.right, bottom: insets.bottom, left: insets.left } : NO_INSETS}
      onDisplayMode={setIsFullscreen}
      onHeight={rememberHeight}
      onModelContext={rememberModelContext}
      onClose={close}
    />
  );

  return (
    <>
    <View
      style={{ height, marginBottom: 8 }}
      className={document.prefersBorder ? "overflow-hidden rounded-lg border border-border bg-card" : undefined}
    >
      {isFullscreen ? null : frame(false)}
      <View className="absolute right-1.5 top-1.5 flex-row gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open app full screen"
          onPress={() => setIsFullscreen(true)}
          className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
        >
          <SymbolView name="arrow.up.left.and.arrow.down.right" size={13} tintColorClassName="accent-icon-muted" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close app"
          onPress={() => (host.current ? void host.current.close() : close())}
          className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
        >
          <SymbolView name="xmark" size={13} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      <Modal visible={isFullscreen} animationType="slide" onRequestClose={() => setIsFullscreen(false)}>
        {/* The app runs under the home indicator and reads the covered part from its safe area insets. */}
        <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
          <View className="min-h-12 flex-row items-center gap-2 px-4">
            <Text numberOfLines={1} className="flex-1 font-t3-medium text-base text-foreground">{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close full screen app"
              onPress={() => setIsFullscreen(false)}
              className="size-11 items-center justify-center"
            >
              <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
          {isFullscreen ? frame(true) : null}
        </View>
      </Modal>
    </View>
    {modelContext ? (
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Shows the context"
        onPress={() => Alert.alert("Context shared with the agent", `The agent gets this with each new turn of this session.\n\n${modelContext}`)}
        className="mb-2 min-h-11 flex-row items-center gap-2"
      >
        <SymbolView name="sparkles" size={16} tintColorClassName="accent-icon-muted" />
        <Text className="text-sm text-foreground-muted">Context shared with the agent</Text>
      </Pressable>
    ) : null}
    </>
  );
}
