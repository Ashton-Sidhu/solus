import { LegendList } from "@legendapp/list/react-native";
import { memo, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { SubagentHistoryStore, type SubagentHistoryState } from "@solus/client-core/subagent-history-store";

import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import type { ScreenProps } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import { TranscriptModel, type TranscriptItem } from "../conversation/lib/transcript-model";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { parseToolInput, toolFullDetail, toolRowLabel } from "./thread-work-log-presentation";
import { useTranscriptItem } from "./use-transcript-items";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** A provider subagent's own feed, pushed over its parent thread. */
export function ProviderSubagentScreen({ route }: ScreenProps<"ThreadSubagent">) {
  const app = useApp();
  const { hostId, conversationId, itemId } = route.params;
  const store = app.openConversation(hostId, conversationId);
  if (!store) return <Text className="p-5 text-sm text-foreground-muted">This conversation is no longer open.</Text>;
  return <ProviderTranscript store={store} itemId={itemId} />;
}

/**
 * Live child rows come from the parent's call. A call without them reads its
 * provider history from the host, through the parent: on open, refresh, and
 * earlier pages. It never polls.
 */
function ProviderTranscript({ store, itemId }: { store: ConversationStore; itemId: string }) {
  const app = useApp();
  const item = useTranscriptItem(store, itemId);
  const api = app.connections.connection(store.controller.hostId)?.api;
  const toolId = item?.kind === "tool" ? item.toolId : null;
  const liveChildren = item?.kind === "tool" && item.children?.order.length ? item.children : null;
  const history = useMemo(
    () => (api && toolId ? new SubagentHistoryStore(api, { ...store.controller.historySource, toolId }) : null),
    [api, store, toolId],
  );
  const saved = useSyncExternalStore(history?.subscribe ?? noSubscribe, history?.read ?? readNothing, history?.read ?? readNothing);
  useEffect(() => {
    if (!liveChildren) void history?.load();
  }, [history, liveChildren]);
  const savedChildren = useMemo(
    () => (saved ? TranscriptModel.fromHistory(`${itemId}:saved`, saved.page) : null),
    [itemId, saved?.page],
  );
  if (item?.kind !== "tool") return <Text className="p-5 text-sm text-foreground-muted">This agent is no longer available.</Text>;
  return (
    <ProviderTranscriptList
      store={store}
      item={item}
      childTranscript={liveChildren ?? savedChildren}
      history={liveChildren ? null : history}
      saved={saved}
    />
  );
}

function ProviderTranscriptList(props: {
  readonly store: ConversationStore;
  readonly item: ToolItem;
  readonly childTranscript: TranscriptModel | null;
  /** The read of provider history; null while the call carries its own rows. */
  readonly history: SubagentHistoryStore | null;
  readonly saved: SubagentHistoryState | null;
}) {
  const { store, item, childTranscript, history, saved } = props;
  const brief = parseToolInput(item.input)?.prompt ?? "";
  const showsBrief = !!brief && !childTranscript?.order.some((id) => childTranscript.items.get(id)?.kind === "user");
  const isLoading = saved?.phase === "loading";
  return (
    <LegendList
      className="flex-1 bg-screen"
      data={childTranscript?.order ?? []}
      keyExtractor={(id) => id}
      renderItem={({ item: childId }) => (
        <ProviderTranscriptRow store={store} parentId={item.id} childId={childId} savedChildren={childTranscript} />
      )}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
      ListHeaderComponent={
        <View className="gap-3 py-4">
          {saved?.phase === "error" ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">{saved.error}</Text>
          ) : null}
          {history ? (
            <View className="flex-row gap-3">
              <Pressable accessibilityRole="button" disabled={isLoading} onPress={() => void history.load()} className="min-h-11 justify-center">
                <Text className="text-sm text-foreground-muted">{isLoading ? "Loading activity…" : "Refresh activity"}</Text>
              </Pressable>
              {saved?.page.before ? (
                <Pressable accessibilityRole="button" disabled={isLoading} onPress={() => void history.load(true)} className="min-h-11 justify-center">
                  <Text className="text-sm text-foreground">Load earlier</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {showsBrief ? (
            <View className="self-end rounded-[20px] bg-card-alt px-3.5 py-3">
              <ThreadMarkdown markdown={brief} tone="user" store={store} />
            </View>
          ) : null}
          {!childTranscript?.order.length ? (
            <Text className="text-sm text-foreground-muted">
              {item.status === "running" ? "Waiting for agent activity…" : "No recorded activity is available for this agent."}
            </Text>
          ) : null}
        </View>
      }
      ListFooterComponent={
        item.report ? (
          <View className="py-3">
            <ThreadMarkdown markdown={item.report} tone="assistant" store={store} />
          </View>
        ) : null
      }
    />
  );
}

/** One child row. A live row follows the parent call's child transcript; a read row is fixed. */
const ProviderTranscriptRow = memo(function ProviderTranscriptRow(props: {
  readonly store: ConversationStore;
  readonly parentId: string;
  readonly childId: string;
  readonly savedChildren: TranscriptModel | null;
}) {
  const { store, parentId, childId, savedChildren } = props;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeItem(`${parentId}\0${childId}`, listener),
    [store, parentId, childId],
  );
  const read = useCallback(() => {
    const parent = store.item(parentId);
    if (parent?.kind !== "tool") return undefined;
    return (parent.children?.order.length ? parent.children : savedChildren)?.items.get(childId);
  }, [store, parentId, childId, savedChildren]);
  const child = useSyncExternalStore(subscribe, read, read);
  if (child?.kind === "assistant" || child?.kind === "user") {
    return (
      <View className="py-2">
        <ThreadMarkdown markdown={child.text} tone={child.kind} store={store} />
      </View>
    );
  }
  if (child?.kind !== "tool") return null;
  const detail = toolFullDetail(child);
  return (
    <View className="gap-1 py-2">
      <Text className={child.status === "error" ? "text-sm text-danger-foreground" : "text-sm text-foreground-secondary"}>
        {toolRowLabel(child)}
      </Text>
      {detail ? <Text selectable className="font-mono text-2xs text-foreground-muted">{detail}</Text> : null}
    </View>
  );
});

const noSubscribe = (_listener: () => void) => () => {};
const readNothing = () => null;
