import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostApi } from "@solus/client-core/host-api";
import { appHostAccessNotice, describeAppPermissions, type AppSnapshot } from "@solus/contracts/apps";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { McpAppWebView, type McpAppCalls } from "./ThreadMcpApp";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 360;

type AppRead = { phase: "loading" } | { phase: "ready"; snapshot: AppSnapshot } | { phase: "error"; message: string };

/**
 * An app work (docs/plans/apps.md) as a row of the feed: the host's composed
 * document in the MCP App web view, with calls that name the work, and the
 * host access bar. A row an earlier revision made is one line that opens the
 * app in place.
 */
export const ThreadApp = memo(function ThreadApp(props: { readonly store: ConversationStore; readonly id: string; readonly superseded: boolean }) {
  const { store, id, superseded } = props;
  const app = useApp();
  const item = useTranscriptItem(store, id);
  const api = app.connections.connection(store.controller.hostId)?.api;
  const [earlierOpen, setEarlierOpen] = useState(false);
  if (!api || item?.kind !== "app") return null;
  if (superseded && !earlierOpen) {
    return (
      <View className="mb-2 min-h-11 flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>An earlier revision of {item.title}</Text>
        <Pressable accessibilityRole="button" onPress={() => setEarlierOpen(true)} className="min-h-11 justify-center px-3">
          <Text className="text-sm text-foreground">Show</Text>
        </Pressable>
      </View>
    );
  }
  return <AppCard store={store} api={api} workId={item.workId} title={item.title} />;
});

function AppCard(props: { readonly store: ConversationStore; readonly api: HostApi; readonly workId: string; readonly title: string }) {
  const { store, api, workId, title } = props;
  const [read, setRead] = useState<AppRead>({ phase: "loading" });
  const [generation, setGeneration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    let live = true;
    setRead({ phase: "loading" });
    api.appRead({ workId }).then(
      (snapshot) => {
        if (live) setRead({ phase: "ready", snapshot });
      },
      (error) => {
        if (live) setRead({ phase: "error", message: error instanceof Error ? error.message : "Could not load this app." });
      },
    );
    return () => {
      live = false;
    };
  }, [api, workId, generation]);

  /** The host's owner allows what the app asks of the host, or revokes it; the answer is the new document. */
  const decideHostAccess = (allow: boolean) => {
    api.appHostAccessDecide({ workId, allow }).then(
      (snapshot) => setRead({ phase: "ready", snapshot }),
      (error) => setRead({ phase: "error", message: error instanceof Error ? error.message : "Could not change this app's host access." }),
    );
  };

  const calls = useMemo<McpAppCalls>(
    () => ({
      toolInfo: (name) => api.appToolInfo({ workId, name }),
      callTool: (name, argumentsJson, approved) => api.appCallTool({ workId, name, argumentsJson, approved }),
      readResource: async () => {
        throw new Error("An app has no resources to read.");
      },
    }),
    [api, workId],
  );
  const webViewSnapshot = useMemo(
    () => (read.phase === "ready" ? { html: read.snapshot.html, csp: read.snapshot.csp, toolInputJson: "{}", toolResultJson: "{}" } : null),
    [read],
  );

  if (isClosed) {
    return (
      <View className="mb-2 min-h-11 flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>The {title} app was closed</Text>
        <Pressable accessibilityRole="button" onPress={() => setIsClosed(false)} className="min-h-11 justify-center px-3">
          <Text className="text-sm text-foreground">Show app</Text>
        </Pressable>
      </View>
    );
  }

  if (read.phase !== "ready" || !webViewSnapshot) {
    return (
      <View className="min-h-28 items-center justify-center gap-2">
        {read.phase === "error" ? (
          <>
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">{read.message}</Text>
            <Pressable accessibilityRole="button" onPress={() => setGeneration((value) => value + 1)} className="min-h-11 justify-center px-4">
              <Text className="text-sm text-foreground">Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading app" />
        )}
      </View>
    );
  }

  const { snapshot } = read;
  const missing = snapshot.roles.filter((role) => !role.connected);
  const hostAccessNotice = appHostAccessNotice(snapshot.hostAccess);
  const frame = (fullscreen: boolean) => (
    <McpAppWebView
      // A host access decision changes the document's policy, so it is a new web view.
      key={snapshot.hostAccess.state}
      snapshot={webViewSnapshot}
      calls={calls}
      store={store}
      isFullscreen={fullscreen}
      onDisplayMode={setIsFullscreen}
      onHeight={setHeight}
      onClose={() => setIsClosed(true)}
    />
  );

  return (
    <View style={{ marginBottom: 8 }}>
      <Text className="mb-1 text-xs text-foreground-muted" numberOfLines={1}>{title} · {describeAppPermissions(snapshot.permissions)}</Text>
      {missing.length > 0 ? (
        <View className="mb-2 rounded-lg border border-border px-3 py-2">
          <Text className="text-sm text-foreground-muted">
            This app uses {missing.map((role) => role.name ?? role.slug).join(", ")} with your own account. Connect {missing.length === 1 ? "it" : "them"} in Settings → MCP, then open the app again.
          </Text>
        </View>
      ) : null}
      {hostAccessNotice ? (
        <View accessibilityRole="summary" className="mb-2 flex-row items-center gap-2 rounded-lg border border-border px-3 py-2">
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted">{hostAccessNotice}</Text>
          {snapshot.hostAccess.canDecide ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={snapshot.hostAccess.state === "pending" ? "Allow this app's host access" : "Revoke this app's host access"}
              onPress={() => decideHostAccess(snapshot.hostAccess.state === "pending")}
              className="min-h-11 justify-center px-3"
            >
              <Text className="text-sm text-foreground">{snapshot.hostAccess.state === "pending" ? "Allow" : "Revoke"}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={{ height }}>
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
            onPress={() => setIsClosed(true)}
            className="size-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
          >
            <SymbolView name="xmark" size={13} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </View>
      </View>
      <Modal visible={isFullscreen} animationType="slide" onRequestClose={() => setIsFullscreen(false)}>
        <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
          <View className="min-h-12 flex-row items-center gap-2 px-4">
            <Text numberOfLines={1} className="flex-1 font-t3-medium text-base text-foreground">{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close full screen app" onPress={() => setIsFullscreen(false)} className="size-11 items-center justify-center">
              <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
          {isFullscreen ? frame(true) : null}
        </View>
      </Modal>
    </View>
  );
}
