import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { type LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { toolCallLines, turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useLinkedSession } from "../../solus/use-linked-session";
import {
  formatItemFullDetail,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "../../lib/threadActivity";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import type { LinkedThreadRouteParams } from "./linkedThreadRoute";
import { BackgroundCommandRow } from "./BackgroundCommandRow";
import { ReadOnlyComposerBar } from "./ReadOnlyComposerBar";
import { ThreadInspectorHeader, type ThreadInspectorPresentation } from "./thread-inspector-header";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

function ActivityRow(props: { readonly activity: ThreadFeedActivity }) {
  const { activity } = props;
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const row = activity.projectedItem;
  const [detail, setDetail] = useState<{ item?: typeof row.item; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    if (open && activity.loadHostDetail)
      void activity.loadHostDetail().then(
        (item) => {
          if (current) setDetail({ item });
        },
        (error) => {
          if (current) setDetail({ error: String(error) });
        },
      );
    return () => {
      current = false;
    };
  }, [open, activity.loadHostDetail, attempt]);
  const fetchedItem = detail?.item;
  const shownItem = fetchedItem ?? row.item;
  // A command or tool call reads as what was called, as on the thread screen; only an item with
  // no call to show falls back to its full detail.
  const call = !open
    ? null
    : shownItem.type === "command_execution"
      ? toolCallLines({ command: shownItem.input })
      : shownItem.type === "dynamic_tool"
        ? toolCallLines({ args: shownItem.input })
        : null;
  const callText = call
    ? (call.command ??
      call.args?.map(([key, value]) => `${key}: ${value}`).join("\n") ??
      call.argsText)
    : null;
  const body = !open
    ? null
    : call
      ? callText
      : fetchedItem
        ? formatItemFullDetail(row, fetchedItem)
        : (activity.getFullDetail() ?? activity.detail);
  const output = open ? (detail?.error ?? turnItemOutputText(shownItem)) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      disabled={!activity.canExpand}
      onPress={() => setOpen(!open)}
      className="active:opacity-70"
    >
      <Text
        numberOfLines={open ? undefined : 1}
        className={`font-mono text-xs ${activity.status === "failure" ? "text-danger-foreground" : "text-foreground-muted"}`}
      >
        {activity.summary}
      </Text>
      {body ? (
        <View className="mt-1 rounded-lg bg-subtle p-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {body}
          </Text>
        </View>
      ) : null}
      {output ? (
        <View className="mt-1 rounded-lg bg-subtle p-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {output}
          </Text>
        </View>
      ) : null}
      {open && detail?.error ? (
        <View className="mt-1.5 self-start">
          <Button
            size="compact"
            tone="secondary"
            label={gt("Try again")}
            onPress={() => setAttempt((n) => n + 1)}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One entry of the thread's feed, as the thread screen's own feed model has it. Only reading
 * rows are drawn: what needs the thread's environment (files, visuals, apps) is left out.
 */
function LinkedThreadEntry(props: { readonly entry: ThreadFeedEntry }) {
  const { entry } = props;
  const styles = useMarkdownPreviewStyles();
  if (entry.type === "activity-group") {
    return (
      <View className="gap-1.5">
        {entry.activities.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} />
        ))}
      </View>
    );
  }
  // A message the agent sent with a tool reads as its own words, as on the thread screen.
  if (entry.type === "sent-message") {
    return <SelectableMarkdownText markdown={entry.text} textStyle={styles.nativeTextStyle} />;
  }
  if (entry.type !== "message" || entry.message.text.trim() === "") return null;
  if (entry.message.backgroundCommand) {
    return <BackgroundCommandRow command={entry.message.backgroundCommand} />;
  }
  return entry.message.role === "user" ? (
    <View className="max-w-[88%] self-end rounded-2xl bg-user-bubble px-3.5 py-2.5">
      <Text selectable className="text-sm text-user-bubble-foreground">
        {entry.message.text}
      </Text>
    </View>
  ) : (
    <SelectableMarkdownText markdown={entry.message.text} textStyle={styles.nativeTextStyle} />
  );
}

function FailureCard(props: {
  readonly failure: { title: string; detail: string; retryable: boolean };
  readonly stale: boolean;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3"
    >
      <Text className="font-t3-medium text-sm text-danger-foreground">{props.failure.title}</Text>
      <Text className="text-sm text-danger-foreground">
        {props.failure.detail}
        {props.stale ? ` ${gt("Showing what was read before.")}` : ""}
      </Text>
      {props.failure.retryable ? (
        <View className="mt-2 self-start">
          <Button size="compact" tone="secondary" label={gt("Try again")} onPress={props.onRetry} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Stands where a composer would: the thread takes no messages from here. `action` is the one way
 * forward it offers, and `notice` what came of it.
 */
function LinkedThreadComposer(props: {
  /** The linked environment the thread is on. */
  readonly label: string;
  /** The environment that reads it. */
  readonly via: string;
  readonly working: boolean;
  readonly action?: React.ReactNode;
  readonly notice?: React.ReactNode;
}) {
  const { label, via } = props;
  const gt = useGT();
  return (
    <>
      {props.notice}
      <ReadOnlyComposerBar>
        <View accessible className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
            <T>Read-only</T>
          </Text>
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {props.working
              ? gt("On {label} via {via} · Working", { label, via })
              : gt("On {label} via {via}", { label, via })}
          </Text>
        </View>
        {props.action}
      </ReadOnlyComposerBar>
    </>
  );
}

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const appIsActive = () => AppState.currentState === "active";

/**
 * A linked environment's thread, read through the environment this app is connected to. The app
 * never connects to the linked one, so the view only reads. It shows in the inspector, where
 * `presentation` maximizes it, or as its own screen, where `presentation` closes it.
 */
export function LinkedThreadView(props: {
  readonly target: LinkedThreadTarget;
  /** Closes the screen by going back when absent. */
  readonly presentation?: ThreadInspectorPresentation;
}) {
  const { target } = props;
  const gt = useGT();
  const navigation = useNavigation();
  const presentation = props.presentation ?? { onClose: () => navigation.goBack() };
  const inInspector = "onMaximize" in presentation;
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const appActive = useSyncExternalStore(subscribeAppState, appIsActive);
  const view = useLinkedSession(target, focused && appActive);
  const label = target.label;
  const via = view.connected ? gt("direct connection") : "Solus Cloud";
  const openThread = useOpenLinkedThread();
  const connect = () => {
    if (view.canOpen) {
      if (!inInspector) navigation.goBack();
      openThread({ environmentId: target.environmentId, threadId: target.threadId });
    } else if (inInspector) navigation.navigate("ConnectionsNew", { linked: target.environmentId });
    else
      navigation.dispatch(StackActions.replace("ConnectionsNew", { linked: target.environmentId }));
  };
  return (
    <View collapsable={false} className={inInspector ? "flex-1 bg-screen" : "flex-1 bg-sheet"}>
      <ThreadInspectorHeader
        {...presentation}
        title={view.title || target.title || gt("Thread on {label}", { label })}
      />
      <ScreenContent>
        <ReadOnlyThreadHistory view={view} label={label} />
        <View
          className="gap-2 px-3 pt-1.5"
          style={{ paddingBottom: Math.max(insets.bottom, 10) + 6 }}
        >
          <LinkedThreadComposer
            label={label}
            via={via}
            working={view.working}
            action={
              view.canOpen || !view.connected ? (
                <Button
                  tone="secondary"
                  label={view.canOpen ? gt("Open session") : gt("Connect to interact")}
                  onPress={connect}
                />
              ) : undefined
            }
          />
        </View>
      </ScreenContent>
    </View>
  );
}

export function ReadOnlyThreadHistory({
  view,
  label,
}: {
  readonly view: Pick<
    ReturnType<typeof useLinkedSession>,
    "error" | "feed" | "ready" | "hasOlder" | "paging" | "retry" | "loadEarlier"
  >;
  readonly label: string;
}) {
  const gt = useGT();
  const failure = view.error
    ? { title: gt("Couldn’t read session"), detail: view.error, retryable: true }
    : null;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Follows new items only while the reader is already at the end.
  const atEnd = useRef(true);
  return (
    <ScrollView
      ref={scroll}
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-3 px-5 pb-3 pt-3"
      // An earlier page lands above what is being read without moving it.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      scrollEventThrottle={64}
      onScroll={({ nativeEvent }) => {
        const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
        atEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
      }}
      onContentSizeChange={() => {
        if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
      }}
    >
      {!view.ready ? (
        failure === null ? (
          <View className="flex-row items-center gap-2 pt-6">
            <AppActivityIndicator size="small" />
            <Text className="text-sm text-foreground-muted">
              {gt("Reading from {label}…", { label })}
            </Text>
          </View>
        ) : (
          <FailureCard failure={failure} stale={false} onRetry={view.retry} />
        )
      ) : (
        <>
          {view.hasOlder ? (
            <View className="self-center">
              <Button
                size="compact"
                tone="text"
                label={gt("Load earlier")}
                loading={view.paging}
                disabled={view.paging}
                onPress={view.loadEarlier}
              />
            </View>
          ) : null}
          {view.feed.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>Nothing in this thread yet.</T>
            </Text>
          ) : null}
          {view.feed.map((entry) => (
            <LinkedThreadEntry key={entry.id} entry={entry} />
          ))}
          {failure === null ? null : <FailureCard failure={failure} stale onRetry={view.retry} />}
        </>
      )}
    </ScrollView>
  );
}

/** The read-only view as its own screen: a sheet, or the whole screen when maximized from the inspector. */
export function LinkedThreadSheet({ route }: StaticScreenProps<LinkedThreadRouteParams>) {
  const { viaEnvironmentId, environmentId, threadId, label, title } = route.params;
  return (
    <LinkedThreadView
      key={`${viaEnvironmentId}:${environmentId}:${threadId}`}
      target={{
        viaEnvironmentId: EnvironmentId.make(viaEnvironmentId),
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make(threadId),
        label,
        title: title ?? null,
      }}
    />
  );
}
