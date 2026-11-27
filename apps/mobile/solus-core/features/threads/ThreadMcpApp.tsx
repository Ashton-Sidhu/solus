// Adapted from T3 Code McpAppWebView.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostApi } from "@solus/client-core/host-api";
import { mcpAppOffersDisplayMode, type McpAppHost, type McpAppLiveCall } from "@solus/client-core/mcp-app-host";
import { MCP_APP_DOCKED_HEIGHT, mcpAppAvailableDisplayModes, type McpAppDisplayMode } from "@solus/client-core/mcp-app-context";
import { mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
import { mcpAppLiveToolName, type McpAppCancelReason, type McpAppLiveDocument, type McpAppReference, type McpAppRequest, type McpAppSnapshot } from "@solus/contracts/mcp-apps";

import { useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { Button } from "../../../src/components/ui/Button";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { useHostApi } from "../hosts/use-host-api";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { McpAppWebView } from "./McpAppWebView";
import { ThreadMcpLiveApp } from "./ThreadMcpLiveApp";
import { useSavedMcpApp } from "./use-saved-mcp-app";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 320;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** A Solus integration tool: its call can show its MCP App while it runs. */
export function canShowLiveApp(item: TranscriptItem): boolean {
  return item.kind === "tool" && mcpAppLiveToolName(item.toolName) !== null;
}

/** An MCP App row of the feed: the app a tool call saved, or the live app of a Solus integration tool's call. */
export function ThreadMcpApp({ store, id }: { store: ConversationStore; id: string }) {
  const item = useTranscriptItem(store, id);
  // No card while the host is not ready: an app's calls would fail.
  const api = useHostApi(store.controller.hostId);
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

  const { app: state, reload } = useSavedMcpApp(api, !isClosed && !isHeldLive ? request : null);

  if (isHeldLive) return null;
  if (!isClosed && state.phase !== "ready") {
    return (
      <View className="min-h-28 items-center justify-center gap-2">
        {state.phase === "error" ? (
          <>
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">{state.message}</Text>
            <Pressable accessibilityRole="button" onPress={reload} className="min-h-11 justify-center px-4">
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
 * the conversation store; the first one keeps its height. A saved app can be
 * docked above the composer (`docked`, `ThreadMcpPipDock`); its card in the
 * feed then shows a line in its place.
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
  /** The card is the docked frame above the composer, not the card in the feed. */
  readonly docked?: boolean;
  /** The keyboard is open: a docked card shows its title bar only. */
  readonly isFolded?: boolean;
}) {
  const { store, api, request, title, document, closedKeys, isClosed, onClosedChange, docked = false } = props;
  const heightKey = closedKeys[0]!;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [height, setHeight] = useState(() => store.mcpAppHeights.get(heightKey) ?? INITIAL_HEIGHT);
  const [modelContext, setModelContext] = useState(() => (request.activityId ? store.mcpAppContexts.get(request.activityId) : undefined));
  const [declaredModes, setDeclaredModes] = useState<readonly McpAppDisplayMode[] | null>(null);
  const insets = useSafeAreaInsets();
  // The frame shown now: closing through it gives the app its teardown first.
  const host = useRef<McpAppHost | null>(null);
  const readPip = useCallback(() => store.mcpAppPip?.activityId, [store]);
  const pipActivityId = useListened(store.mcpAppPipChanges, readPip);
  const isPip = !!request.activityId && pipActivityId === request.activityId;
  // The docked frame is a new frame of the saved app, so only a saved app can be docked.
  const availableModes = mcpAppAvailableDisplayModes({ isSaved: !!request.activityId });
  const offersPip = !docked && mcpAppOffersDisplayMode("pip", availableModes, declaredModes);
  const offersFullscreen = mcpAppOffersDisplayMode("fullscreen", availableModes, declaredModes);

  // The docked frame may close the app; its card in the feed reads that when the dock goes.
  useEffect(() => {
    if (docked) return;
    return store.mcpAppPipChanges.subscribe(() => onClosedChange(closedKeys.some((key) => store.closedMcpApps.has(key))));
  }, [docked, store, closedKeys, onClosedChange]);

  // The conversation store keeps these across a remount of the row.
  const setClosed = (next: boolean) => {
    if (next) store.closedMcpApps.add(closedKeys[0]!);
    else for (const key of closedKeys) store.closedMcpApps.delete(key);
    onClosedChange(next);
  };
  const rememberHeight = (next: number) => {
    // A docked frame has a fixed height; the card keeps the height the app asked for inline.
    if (docked) return;
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
  /** A mode the bridge granted, or the person chose. Answers the mode that results. */
  const setMode = (mode: McpAppDisplayMode): McpAppDisplayMode => {
    // Only a saved app is docked; the bridge does not grant `pip` before (`availableModes`).
    if (mode === "pip" && !request.activityId) return isFullscreen ? "fullscreen" : "inline";
    setIsFullscreen(mode === "fullscreen");
    if (mode === "pip") store.setMcpAppPip({ activityId: request.activityId, title });
    else if (mode === "inline" && docked) store.setMcpAppPip(null);
    return mode;
  };

  if (isClosed || !document || (isPip && !docked)) {
    return <McpAppCardLine title={title} height={height} isPip={isPip && !isClosed} onReturn={() => store.setMcpAppPip(null)} onShow={() => setClosed(false)} />;
  }

  // Each presentation is its own frame: the inline or docked one, and the full-screen one.
  const frame = (displayMode: McpAppDisplayMode) => (
    <McpAppWebView
      snapshot={document}
      call={props.call}
      savedCall={props.savedCall}
      api={api}
      request={request}
      store={store}
      title={title}
      hostRef={host}
      displayMode={displayMode}
      availableDisplayModes={availableModes}
      safeAreaInsets={displayMode === "fullscreen" ? { top: 0, right: insets.right, bottom: insets.bottom, left: insets.left } : NO_INSETS}
      onDisplayMode={setMode}
      onDeclaredDisplayModes={setDeclaredModes}
      onHeight={rememberHeight}
      onModelContext={rememberModelContext}
      onClose={close}
    />
  );
  const fullscreen = (
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
        {isFullscreen ? frame("fullscreen") : null}
      </View>
    </Modal>
  );
  const closeApp = () => (host.current ? void host.current.close() : close());

  if (docked) {
    return (
      <DockedMcpApp
        title={title}
        isFolded={props.isFolded === true}
        offersFullscreen={offersFullscreen}
        onReturn={() => setMode("inline")}
        onFullscreen={() => setIsFullscreen(true)}
        onClose={closeApp}
        frame={isFullscreen ? null : frame("pip")}
      >
        {fullscreen}
      </DockedMcpApp>
    );
  }

  return (
    <>
      {isFullscreen ? (
        <View style={{ height, marginBottom: 8 }} className="items-center justify-center rounded-lg border border-border">
          <Text className="text-sm text-foreground-muted">The {title} app is open full screen</Text>
        </View>
      ) : (
        <View
          style={{ height, marginBottom: 8 }}
        >
          {frame("inline")}
          <View className="absolute right-1.5 top-1.5 flex-row gap-1">
            {offersPip ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Keep in view"
                onPress={() => setMode("pip")}
                className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
              >
                <SymbolView name={{ ios: "pip.enter", android: "visibility" }} size={13} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ) : null}
            {offersFullscreen ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open app full screen"
                onPress={() => setIsFullscreen(true)}
                className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
              >
                <SymbolView name="arrow.up.left.and.arrow.down.right" size={13} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close app"
              onPress={closeApp}
              className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
            >
              <SymbolView name="xmark" size={13} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
        </View>
      )}
      {fullscreen}
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

/** The card's place in the feed while it shows no frame: the app was closed, or it is docked in picture-in-picture. */
function McpAppCardLine(props: { readonly title: string; readonly height: number; readonly isPip: boolean; readonly onReturn: () => void; readonly onShow: () => void }) {
  const { title, height, isPip } = props;
  return (
    <View style={{ height, marginBottom: 8 }} className="items-center justify-center gap-2 rounded-lg border border-border">
      <Text className="text-sm text-foreground-muted">{isPip ? `The ${title} app is in picture-in-picture` : `The ${title} app was closed`}</Text>
      <View className="items-center">
        <Button label={isPip ? "Return to card" : "Show app"} tone="secondary"
          onPress={isPip ? props.onReturn : props.onShow} />
      </View>
    </View>
  );
}

/** The docked frame above the composer: a title bar with its controls, and the app below it, folded while the keyboard is open. */
function DockedMcpApp(props: {
  readonly title: string;
  readonly isFolded: boolean;
  readonly offersFullscreen: boolean;
  readonly onReturn: () => void;
  readonly onFullscreen: () => void;
  readonly onClose: () => void;
  readonly frame: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="mx-4 mb-3 overflow-hidden">
      <View className="min-h-11 flex-row items-center pl-4">
        <Text numberOfLines={1} className="flex-1 font-t3-medium text-sm text-foreground">{props.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Return to card" onPress={props.onReturn} className="size-11 items-center justify-center">
          <SymbolView name={{ ios: "pip.exit", android: "visibility" }} size={16} tintColorClassName="accent-icon-muted" />
        </Pressable>
        {props.offersFullscreen ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Open app full screen" onPress={props.onFullscreen} className="size-11 items-center justify-center">
            <SymbolView name="arrow.up.left.and.arrow.down.right" size={16} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Close app" onPress={props.onClose} className="size-11 items-center justify-center">
          <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      {/* The frame keeps running while it is folded to its title. */}
      <View style={{ height: props.isFolded ? 0 : MCP_APP_DOCKED_HEIGHT }}>{props.frame}</View>
      {props.children}
    </View>
  );
}
