// Adapted from T3 Code McpAppWebView.tsx (MIT, see UPSTREAM.md).
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useCSSVariable } from "uniwind";
import { z } from "zod";
import type { HostApi } from "@solus/client-core/host-api";
import { nativeMcpAppDocument, nativeMcpAppPost } from "@solus/client-core/mcp-app-document";
import { mcpAppHostContext, type McpAppDisplayMode } from "@solus/client-core/mcp-app-context";
import { createMcpAppHost, type McpAppHost, type McpAppLiveCall } from "@solus/client-core/mcp-app-host";
import type { McpAppCancelReason, McpAppLiveDocument, McpAppRequest, McpAppSnapshot } from "@solus/contracts/mcp-apps";

import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../../../src/features/settings/appearance/AppearancePreferencesProvider";
import type { ConversationStore } from "../conversation/conversation-store";

const relayMessageSchema = z.object({ secret: z.string(), json: z.string().optional(), navigated: z.boolean().optional() });

// An alert shows its text in the system font, so a sentence and tool arguments need no different format here.
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

/**
 * One app frame. The bridge belongs to one web view load: a retry, a new
 * snapshot, or an unmount disposes it, and a navigation of the app stops it.
 */
export function McpAppWebView(props: {
  readonly snapshot: McpAppSnapshot | McpAppLiveDocument;
  /** A live card's call as the transcript shows it now; null when the screen is hidden and the call runs. */
  readonly call?: McpAppLiveCall | null;
  /** A live card's saved app, once its call ended. */
  readonly savedCall?: Pick<McpAppSnapshot, "toolInputJson" | "toolResultJson">;
  readonly api: HostApi;
  readonly request: McpAppRequest;
  readonly store: ConversationStore;
  readonly title: string;
  readonly hostRef: { current: McpAppHost | null };
  readonly displayMode: McpAppDisplayMode;
  /** What the card can give this frame now (`mcpAppAvailableDisplayModes`). */
  readonly availableDisplayModes: McpAppDisplayMode[];
  readonly safeAreaInsets: { top: number; right: number; bottom: number; left: number };
  /** Puts the card in a mode the bridge granted; answers the mode that results. */
  readonly onDisplayMode: (mode: McpAppDisplayMode) => McpAppDisplayMode;
  readonly onDeclaredDisplayModes?: (modes: readonly McpAppDisplayMode[] | null) => void;
  readonly onHeight: (height: number) => void;
  readonly onModelContext: (text: string) => void;
  readonly onClose: (cancelled?: McpAppCancelReason) => void;
}) {
  const { snapshot, call, savedCall, api, store, title, hostRef, displayMode, availableDisplayModes, safeAreaInsets } = props;
  const app = useApp();
  const { themeVariables: theme, themeAppearance } = useAppearancePreferences();
  const [info, success] = useCSSVariable(["--color-adaptive-sky-600-400", "--color-adaptive-emerald-600-400"]);
  const webView = useRef<WebView<object>>(null);
  const host = hostRef;
  const [secret] = useState(() => app.platform.uuid());
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const source = useMemo(() => ({ html: nativeMcpAppDocument(snapshot, secret) }), [snapshot, secret]);

  const context = mcpAppHostContext({
    theme: themeAppearance,
    displayMode,
    availableDisplayModes,
    size: frameSize,
    platform: "mobile",
    touch: true,
    hover: false,
    safeAreaInsets,
    palette: {
      background: theme["--color-screen"],
      raised: theme["--color-card"],
      strong: theme["--color-card-alt"],
      text: theme["--color-foreground"],
      textSecondary: theme["--color-foreground-secondary"],
      textTertiary: theme["--color-foreground-tertiary"],
      border: theme["--color-border"],
      accent: theme["--color-focus"],
      info: typeof info === "string" ? info : theme["--color-focus"],
      danger: theme["--color-danger-foreground"],
      success: typeof success === "string" ? success : theme["--color-update-foreground"],
      warning: theme["--color-warning-foreground"],
      fontSans: "-apple-system,system-ui,sans-serif",
      fontMono: "ui-monospace,Menlo,monospace",
    },
  });
  // The bridge outlives renders; it reads the newest context and callbacks.
  const latest = useRef({ props, context });
  latest.current = { props, context };

  useEffect(() => {
    const bridge = createMcpAppHost({
      snapshot,
      title,
      context: () => latest.current.context,
      // This client cannot hold a feature to one approved app inside the web view, so it grants none.
      permissions: () => [],
      post: (json) => webView.current?.injectJavaScript(nativeMcpAppPost(json)),
      // A live card names its saved app only once its call ended; the bridge refuses these calls before that.
      toolInfo: (name) => api.mcpAppToolInfo({ ...latest.current.props.request, name }),
      callTool: (name, argumentsJson, approved) => api.mcpAppCallTool({ ...latest.current.props.request, name, argumentsJson, approved }),
      readResource: (uri) => api.mcpAppReadResource({ ...latest.current.props.request, uri }),
      confirm: confirmWithAlert,
      sendMessage: (text) => store.controller.send(text, { delivery: "queue" }),
      updateModelContext: async (text) => {
        await api.mcpAppUpdateModelContext({ ...latest.current.props.request, text });
        latest.current.props.onModelContext(text);
      },
      openLink: (url) => app.platform.openBrowser(url),
      displayMode: (mode) => latest.current.props.onDisplayMode(mode),
      declaredDisplayModes: (modes) => latest.current.props.onDeclaredDisplayModes?.(modes),
      resize: (height) => latest.current.props.onHeight(height),
      close: (cancelled) => latest.current.props.onClose(cancelled),
    });
    host.current = bridge;
    return () => {
      bridge.dispose();
      host.current = null;
    };
  }, [app, snapshot, title, host, api, store, generation]);

  // A live card follows its call; the bridge heals and limits partial input.
  useEffect(() => {
    if (call) host.current?.followCall(call);
  }, [call, generation, host]);
  useEffect(() => {
    if (savedCall) host.current?.toolResult(savedCall);
  }, [savedCall, generation, host]);

  // Inline, the app's own height report is not a change of the app's box.
  const frameHeight = displayMode === "inline" ? undefined : frameSize.height;
  const availableModes = availableDisplayModes.join();
  useEffect(() => {
    host.current?.updateContext();
  }, [themeAppearance, displayMode, availableModes, frameSize.width, frameHeight, safeAreaInsets.right, safeAreaInsets.bottom, safeAreaInsets.left]);

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
      // A docked frame folds to no height while the keyboard is open; the app keeps the size it last had.
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.height > 0) setFrameSize({ width: Math.round(layout.width), height: Math.round(layout.height) });
      }}
      onMessage={onMessage}
      onError={() => setFailed(true)}
      onContentProcessDidTerminate={() => setFailed(true)}
      onRenderProcessGone={() => setFailed(true)}
    />
  );
}
