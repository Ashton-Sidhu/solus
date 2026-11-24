import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { AppProvider, useListened } from "@solus-mobile/app/app-context";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { McpAppHost } from "@solus/client-core/mcp-app-host";
import { McpAppWebView } from "@solus-mobile/features/threads/McpAppWebView";
import { useSavedMcpApp } from "@solus-mobile/features/threads/use-saved-mcp-app";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AppBar } from "../../components/ui/AppBar";
import { mobileHost } from "../../state/mobile-host";
import { useThreadSession } from "../../solus/use-thread-session";
import { solus } from "../../solus/runtime";

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly conversationThreadId?: string;
  readonly itemId: string;
  readonly revision?: string;
}>;

/** Resolve apps from stored tool calls so links cannot supply apps the call never produced. */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const { environmentId, threadId, itemId } = route.params;
  if (!environmentId?.trim() || !threadId?.trim() || !itemId?.trim()) {
    return (
      <View className="flex-1 bg-screen">
        <AppBar
          title={gt("App")}
          onClose={() => navigation.goBack()}
          closeAccessibilityLabel={gt("Exit full screen")}
        />
        <Text className="m-6 text-sm text-foreground-muted">
          <T>This app cannot be shown.</T>
        </Text>
      </View>
    );
  }
  return (
    <McpAppFullscreen
      key={JSON.stringify([environmentId, threadId, itemId])}
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      itemId={TurnItemId.make(itemId)}
    />
  );
}

function McpAppFullscreen({
  environmentId,
  threadId,
  itemId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  itemId: TurnItemId;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const session = useThreadSession({ environmentId, threadId });
  const host = useAtomValue(mobileHost(environmentId));
  const request = useMemo(
    () => ({ sessionId: threadId, activityId: itemId.replace(/^activity:/, "") }),
    [threadId, itemId],
  );
  const { app, reload } = useSavedMcpApp(host?.api, request);
  const item =
    session.kind === "ready" ? session.store.item("activity:" + request.activityId) : null;
  const title = item?.kind === "mcp_app" ? item.app.title : "App";
  const [exitRequested, setExitRequested] = useState(false);
  const close = () => setExitRequested(true);
  const focused = useIsFocused();
  useEffect(() => {
    if (exitRequested && focused) navigation.goBack();
  }, [exitRequested, focused, navigation]);
  const hostRef = useRef<McpAppHost | null>(null);
  const insets = useSafeAreaInsets();
  return (
    <AppProvider app={solus}>
      <View className="flex-1 bg-screen">
        <AppBar title={title} onClose={close} closeAccessibilityLabel="Exit full screen" />
        {!host ? (
          <Text className="m-6">Reconnect to the session to open this app.</Text>
        ) : session.kind === "unavailable" ? (
          <View className="m-6">
            <Text accessibilityRole="alert">
              {session.detail ?? gt("This session is unavailable on this host.")}
            </Text>
            {session.recovery ? <Button label={gt("Try again")} onPress={session.recovery.run} /> : null}
          </View>
        ) : app.phase === "error" ? (
          <View className="m-6">
            <Text accessibilityRole="alert">{app.message}</Text>
            <Button label="Try again" onPress={reload} />
          </View>
        ) : app.phase !== "ready" || session.kind !== "ready" ? (
          <ActivityIndicator accessibilityLabel="Loading app" />
        ) : (
          <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
            <CloseOnInputRequest store={session.store} />
            <McpAppWebView
              snapshot={app.snapshot}
              api={host.api}
              store={session.store}
              request={request}
              title={title}
              hostRef={hostRef}
              displayMode="fullscreen"
              availableDisplayModes={["inline", "fullscreen"]}
              safeAreaInsets={insets}
              onDisplayMode={(mode) => {
                if (mode !== "fullscreen") close();
                return mode;
              }}
              onHeight={(height) => session.store.mcpAppHeights.set(request.activityId, height)}
              onModelContext={(text) => {
                if (text) session.store.mcpAppContexts.set(request.activityId, text);
                else session.store.mcpAppContexts.delete(request.activityId);
              }}
              onClose={close}
            />
          </View>
        )}
      </View>
    </AppProvider>
  );
}

function CloseOnInputRequest({ store }: { store: ConversationStore }) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const waiting = !!(meta.questions.length || meta.permissions.length);
  useEffect(() => {
    if (focused && waiting) navigation.goBack();
  }, [focused, waiting, navigation]);
  return null;
}
