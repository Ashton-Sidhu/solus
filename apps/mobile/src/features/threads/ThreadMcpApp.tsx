// Adapted from T3 Code McpAppWebView.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { z } from "zod";
import type { HostApi } from "@solus/client-core/host-api";
import { nativeMcpAppDocument, nativeMcpAppPost } from "@solus/client-core/mcp-app-document";
import { createMcpAppHost, type McpAppHost, type McpAppHostContext } from "@solus/client-core/mcp-app-host";
import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
import type { McpAppReference, McpAppRequest, McpAppSnapshot } from "@solus/contracts/mcp-apps";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ConversationStore } from "../conversation/conversation-store";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 320;
const CLOSED_APP: McpAppRead = { phase: "idle" };
const relayMessageSchema = z.object({ secret: z.string(), json: z.string().optional(), navigated: z.boolean().optional() });

function confirmWithAlert(title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      detail,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Allow", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** An MCP App saved by a tool call, as a row of the feed. */
export function ThreadMcpApp({ store, id }: { store: ConversationStore; id: string }) {
  const app = useApp();
  const item = useTranscriptItem(store, id);
  const api = app.connections.connection(store.controller.hostId)?.api;
  if (!api || item?.kind !== "mcp_app") return null;
  return <McpAppCard store={store} api={api} activityId={item.activityId} sessionId={item.sessionId} reference={item.app} />;
}

function McpAppCard(props: {
  readonly store: ConversationStore;
  readonly api: HostApi;
  readonly activityId: string;
  readonly sessionId: string;
  readonly reference: McpAppReference;
}) {
  const { store, api, activityId, sessionId, reference } = props;
  const apps = useMemo(() => mcpAppsFor(api), [api]);
  const request = useMemo(() => ({ sessionId, activityId }), [sessionId, activityId]);
  const [isClosed, setIsClosed] = useState(() => store.closedMcpApps.has(activityId));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [height, setHeight] = useState(() => store.mcpAppHeights.get(activityId) ?? INITIAL_HEIGHT);
  const insets = useSafeAreaInsets();

  const subscribe = useCallback((listener: () => void) => (isClosed ? () => {} : apps.subscribe(request, listener)), [apps, request, isClosed]);
  const read = useCallback(() => (isClosed ? CLOSED_APP : apps.read(request)), [apps, request, isClosed]);
  const state = useSyncExternalStore(subscribe, read, read);

  useEffect(() => {
    if (!isClosed) void apps.load(request);
  }, [apps, request, isClosed]);

  // The conversation store keeps these across a remount of the row.
  const setClosed = (next: boolean) => {
    if (next) store.closedMcpApps.add(activityId);
    else store.closedMcpApps.delete(activityId);
    setIsClosed(next);
  };
  const rememberHeight = (next: number) => {
    store.mcpAppHeights.set(activityId, next);
    setHeight(next);
  };
  const close = () => {
    setClosed(true);
    setIsFullscreen(false);
  };

  if (isClosed) {
    return (
      <View style={{ height, marginBottom: 8 }} className="items-center justify-center gap-2 rounded-lg border border-border">
        <Text className="text-sm text-foreground-muted">The {reference.title} app was closed</Text>
        <Pressable accessibilityRole="button" onPress={() => setClosed(false)} className="min-h-11 justify-center px-3">
          <Text className="text-sm text-foreground">Show app</Text>
        </Pressable>
      </View>
    );
  }

  if (state.phase !== "ready") {
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

  // Inline and full screen are separate frames: each presentation starts its own app.
  const frame = (fullscreen: boolean) => (
    <McpAppWebView
      snapshot={state.snapshot}
      api={api}
      request={request}
      store={store}
      isFullscreen={fullscreen}
      onDisplayMode={setIsFullscreen}
      onHeight={rememberHeight}
      onClose={close}
    />
  );

  return (
    <View style={{ height, marginBottom: 8 }}>
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
          onPress={() => setClosed(true)}
          className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
        >
          <SymbolView name="xmark" size={13} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      <Modal visible={isFullscreen} animationType="slide" onRequestClose={() => setIsFullscreen(false)}>
        <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
          <View className="min-h-12 flex-row items-center gap-2 px-4">
            <Text numberOfLines={1} className="flex-1 font-t3-medium text-base text-foreground">{reference.title}</Text>
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
  );
}

/**
 * One app frame. The bridge belongs to one web view load: a retry, a new
 * snapshot, or an unmount disposes it, and a navigation of the app stops it.
 */
function McpAppWebView(props: {
  readonly snapshot: McpAppSnapshot;
  readonly api: HostApi;
  readonly request: McpAppRequest;
  readonly store: ConversationStore;
  readonly isFullscreen: boolean;
  readonly onDisplayMode: (fullscreen: boolean) => void;
  readonly onHeight: (height: number) => void;
  readonly onClose: () => void;
}) {
  const { snapshot, api, request, store, isFullscreen } = props;
  const app = useApp();
  const theme = useUniwindTheme();
  const { themeAppearance } = useAppearancePreferences();
  const webView = useRef<WebView<object>>(null);
  const host = useRef<McpAppHost | null>(null);
  const [secret] = useState(() => app.platform.uuid());
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const source = useMemo(() => ({ html: nativeMcpAppDocument(snapshot, secret) }), [snapshot, secret]);

  const context: McpAppHostContext = {
    theme: themeAppearance,
    displayMode: isFullscreen ? "fullscreen" : "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    platform: "mobile",
    styles: {
      variables: {
        "--color-background-primary": theme["--color-screen"],
        "--color-background-secondary": theme["--color-card"],
        "--color-text-primary": theme["--color-foreground"],
        "--color-text-secondary": theme["--color-foreground-muted"],
        "--color-border-primary": theme["--color-border"],
        "--font-sans": "-apple-system,system-ui,sans-serif",
      },
    },
  };
  // The bridge outlives renders; it reads the newest context and callbacks.
  const latest = useRef({ props, context });
  latest.current = { props, context };

  useEffect(() => {
    const bridge = createMcpAppHost({
      snapshot,
      context: () => latest.current.context,
      post: (json) => webView.current?.injectJavaScript(nativeMcpAppPost(json)),
      toolInfo: (name) => api.mcpAppToolInfo({ ...request, name }),
      callTool: (name, argumentsJson, approved) => api.mcpAppCallTool({ ...request, name, argumentsJson, approved }),
      readResource: (uri) => api.mcpAppReadResource({ ...request, uri }),
      confirm: confirmWithAlert,
      sendMessage: (text) => store.controller.send(text, { delivery: "queue" }),
      openLink: (url) => app.platform.openBrowser(url),
      displayMode: (mode) => latest.current.props.onDisplayMode(mode === "fullscreen"),
      resize: (height) => latest.current.props.onHeight(height),
      close: () => latest.current.props.onClose(),
    });
    host.current = bridge;
    return () => {
      bridge.dispose();
      host.current = null;
    };
  }, [app, snapshot, api, request, store, generation]);

  useEffect(() => {
    host.current?.updateContext();
  }, [themeAppearance, isFullscreen]);

  const onMessage = (event: WebViewMessageEvent) => {
    let message: z.infer<typeof relayMessageSchema>;
    try {
      message = relayMessageSchema.parse(JSON.parse(event.nativeEvent.data));
    } catch {
      return;
    }
    if (message.secret !== secret) return;
    if (message.navigated) {
      host.current?.dispose();
      setFailed(true);
    } else if (message.json) {
      void host.current?.receive(message.json);
    }
  };

  if (failed) {
    return (
      <View className="flex-1 items-center justify-center gap-2">
        <Text className="text-sm text-foreground-muted">This app could not be displayed.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setGeneration((value) => value + 1);
            setFailed(false);
          }}
          className="min-h-11 justify-center px-4"
        >
          <Text className="text-sm text-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  }

  // The page itself never navigates; the app's frame inside it may, and its relay then stops.
  return (
    <WebView<object>
      key={generation}
      ref={webView}
      source={source}
      originWhitelist={["about:*", "data:*"]}
      style={{ flex: 1, backgroundColor: "transparent" }}
      scrollEnabled={false}
      bounces={false}
      allowFileAccess={false}
      onShouldStartLoadWithRequest={(load) => load.isTopFrame === false || load.url.startsWith("about:") || load.url.startsWith("data:")}
      onMessage={onMessage}
      onError={() => setFailed(true)}
      onContentProcessDidTerminate={() => setFailed(true)}
      onRenderProcessGone={() => setFailed(true)}
    />
  );
}
