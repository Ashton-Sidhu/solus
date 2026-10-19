// Adapted from T3 Code apps/mobile/src/features/threads/thread-subagent-group.tsx,
// SubagentRow.tsx, SubagentStatusDot.tsx and ThreadAgentsSheet.tsx (MIT, see
// UPSTREAM.md), on Solus's agents (`agent-card-presentation.ts`).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View, type ColorValue } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import type { RootStackParamList, ScreenProps } from "../../navigation/routes";
import { conversationIdOf, type ConversationStore } from "../conversation/conversation-store";
import {
  agentPresentation,
  agentsElapsedMs,
  formatAgentElapsed,
  summarizeAgents,
  type AgentRowPresentation,
  type AgentTone,
} from "./agent-card-presentation";
import { agentCandidates, agentRoster } from "./agent-roster";
import { useTranscriptItems } from "./use-transcript-items";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { WorkLogBlock } from "./work-log-layout";

const TONE_DOT: { readonly [tone in AgentTone]: string } = {
  working: "bg-adaptive-sky-600-400",
  waiting: "bg-adaptive-amber-700-400",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
};

const TONE_TEXT: { readonly [tone in AgentTone]: string } = {
  working: "text-adaptive-sky-600-400",
  waiting: "text-adaptive-amber-700-400",
  completed: "text-adaptive-emerald-600-400",
  failed: "text-adaptive-rose-600-400",
  stopped: "text-foreground-muted",
};

type Navigation = NativeStackNavigationProp<RootStackParamList>;

/**
 * Presentations for agent items, with each Solus session's own record from the
 * host's list: its generated title, model, and whether it can be opened. Reads
 * the list once per directory change, not per row.
 */
export function useAgentPresentations(store: ConversationStore, ids: readonly string[]): readonly AgentRowPresentation[] {
  const app = useApp();
  const hostId = store.controller.hostId;
  const items = useTranscriptItems(store, ids);
  // A new array only when the host's list is read again.
  const listed = useListened(app.threads.changes, app.threads.threads);
  const children = useListened(app.threads.changes, app.threads.childThreads);
  const parentSessionId = store.controller.run.sessionId;
  const agentCount = items.filter((item) => item.kind === "agent").length;
  // The list answers top-level sessions only: the agents' own records are read
  // for their cards, again when a new agent starts.
  useEffect(() => {
    if (agentCount > 0 && parentSessionId) void app.threads.loadChildren(hostId, parentSessionId);
  }, [agentCount, app, hostId, parentSessionId]);
  return useMemo(() => {
    void listed;
    void children;
    const parent = app.threads.thread(hostId, store.controller.run.sessionId)?.record ?? null;
    return items.flatMap((item) => {
      const child = item.kind === "agent" ? (app.threads.thread(hostId, item.sessionId)?.record ?? null) : null;
      const presentation = agentPresentation(item, child, parent);
      return presentation ? [presentation] : [];
    });
  }, [app, children, hostId, items, listed, store]);
}

/** Its own component so the clock repaints this text only. */
function AgentElapsed(props: { readonly rows: readonly AgentRowPresentation[] }) {
  const now = useVisibleSecondClock(props.rows.some((row) => row.live));
  const elapsed = agentsElapsedMs(props.rows, now);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{formatAgentElapsed(elapsed)}</Text>
  );
}

function AgentRowContent(props: { readonly row: AgentRowPresentation }) {
  const { row } = props;
  return (
    <View className="flex-row gap-3">
      <View className="h-5 justify-center">
        <View className={cn("h-2 w-2 rounded-full", TONE_DOT[row.tone])} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-sm text-foreground">
              {row.title}
            </Text>
            <Text accessibilityElementsHidden importantForAccessibility="no" className="text-xs text-foreground-muted">
              ·
            </Text>
            <Text numberOfLines={1} className={cn("shrink-0 text-xs font-t3-medium", TONE_TEXT[row.tone])}>
              {row.statusLabel}
            </Text>
          </View>
          <AgentElapsed rows={[row]} />
          {row.sessionId || row.providerItemId ? <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" /> : null}
        </View>
        {row.meta || row.workspace.length > 0 ? (
          <View className="min-w-0 flex-row items-center gap-1.5">
            <ProviderIcon provider={row.provider} size={12} />
            {row.meta ? (
              <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
                {row.meta}
              </Text>
            ) : null}
            {row.workspace.map(({ label, value }) => (
              // The row reads this label in place of the icon; collapsable keeps
              // the view, and its label, from being flattened away.
              <View
                key={label}
                collapsable={false}
                accessibilityLabel={`${label}: ${value}`}
                className="min-w-0 shrink flex-row items-center gap-1.5"
              >
                <Text className="text-xs text-foreground-muted">·</Text>
                <SymbolView
                  name={label === "Branch" ? "arrow.triangle.branch" : "folder"}
                  size={11}
                  tintColorClassName="accent-icon-muted"
                />
                <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
                  {value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {row.detail ? (
          <Text numberOfLines={3} className={cn("text-xs text-foreground-muted", row.tone === "failed" && TONE_TEXT.failed)}>
            {row.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A row opens its Solus session or its recorded provider child. */
function AgentRow(props: { readonly row: AgentRowPresentation; readonly onOpen: (sessionId: string) => void; readonly onOpenProvider: (itemId: string) => void; readonly className: string }) {
  const { row } = props;
  const label = `${row.title}, ${row.statusLabel}${row.meta ? `, ${row.meta}` : ""}`;
  if (!row.sessionId && !row.providerItemId) {
    return (
      <View accessible accessibilityLabel={label} accessibilityHint={row.unopenableReason ?? undefined} className={props.className}>
        <AgentRowContent row={row} />
      </View>
    );
  }
  const sessionId = row.sessionId;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={sessionId ? "Opens this agent's session" : "Opens this agent's activity"}
      onPress={() => {
        void Haptics.selectionAsync();
        if (sessionId) props.onOpen(sessionId);
        else if (row.providerItemId) props.onOpenProvider(row.providerItemId);
      }}
      className={cn(props.className, "active:bg-subtle")}
    >
      <AgentRowContent row={row} />
    </Pressable>
  );
}

/**
 * Consecutive agents of one turn in the feed. One agent shows as its row;
 * several show a summary that expands in place. Opening a session pushes it,
 * so Back returns to this conversation where it was left.
 */
export function ThreadAgentGroup(props: {
  readonly store: ConversationStore;
  readonly itemIds: readonly string[];
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: () => void;
}) {
  const navigation = useNavigation<Navigation>();
  const rows = useAgentPresentations(props.store, props.itemIds);
  const hostId = props.store.controller.hostId;
  if (rows.length === 0) return null;
  const grouped = rows.length > 1;
  const summary = summarizeAgents(rows);
  const open = (sessionId: string) => navigation.push("Thread", { hostId, sessionId });
  return (
    <WorkLogBlock>
      {grouped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${rows.length} agents, ${summary}`}
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="min-h-14 flex-row items-center gap-3 rounded-lg py-2 active:bg-subtle"
        >
          <View className="flex-row items-center">
            {rows.slice(0, 3).map((row, index) => (
              <View
                key={row.id}
                accessible={false}
                className="h-7 w-7 items-center justify-center rounded-full border border-border bg-card"
                style={{ marginLeft: index === 0 ? 0 : -7 }}
              >
                <ProviderIcon provider={row.provider} size={15} />
              </View>
            ))}
            {rows.length > 3 ? (
              <View className="-ml-2 h-7 w-7 items-center justify-center rounded-full border border-border bg-card">
                <Text className="text-2xs text-foreground-muted">+{rows.length - 3}</Text>
              </View>
            ) : null}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
              {rows.length} agents
            </Text>
            <Text
              numberOfLines={1}
              className={cn(
                "text-2xs text-foreground-muted",
                rows.some((row) => row.live) ? TONE_TEXT.working : rows.some((row) => row.tone === "failed") && TONE_TEXT.failed,
              )}
            >
              {summary}
            </Text>
          </View>
          <AgentElapsed rows={rows} />
          <SymbolView name={props.expanded ? "chevron.up" : "chevron.down"} size={11} tintColor={props.iconSubtleColor} />
        </Pressable>
      ) : null}
      {!grouped || props.expanded ? (
        <View className="mb-1 gap-px rounded-xl border border-border bg-card/30 p-1">
          {rows.map((row) => (
            <AgentRow key={row.id} row={row} onOpen={open} onOpenProvider={(itemId) => navigation.push("ThreadSubagent", { hostId, conversationId: conversationIdOf(props.store), itemId })} className="rounded-lg px-3 py-3" />
          ))}
        </View>
      ) : null}
    </WorkLogBlock>
  );
}

/**
 * The agents of the Agents pill and sheet: the newest turn's, and earlier
 * ones that still work or wait (`agent-roster.ts`). Every candidate's item is
 * subscribed, so an earlier agent that settles leaves the list without a new
 * row in the transcript.
 */
export function useAgentRoster(store: ConversationStore): readonly AgentRowPresentation[] {
  const order = useListened(store.order, store.orderSnapshot);
  const candidates = useMemo(() => agentCandidates(store, order), [store, order]);
  const rows = useAgentPresentations(store, candidates.ids);
  return useMemo(() => agentRoster(rows, candidates), [rows, candidates]);
}

/**
 * The Agents pill's agents (`useAgentRoster`): T3 Code's form sheet
 * (half height, drawn up to 0.9) with a native header on iOS. Opening an agent
 * replaces the sheet with its session, so Back returns to the thread beneath.
 */
export function ThreadAgentsSheet({ route, navigation }: ScreenProps<"ThreadAgents">) {
  const { hostId, conversationId } = route.params;
  const app = useApp();
  const store = app.openConversation(hostId, conversationId);
  return store ? (
    <ThreadAgentsSheetContent store={store} navigation={navigation} />
  ) : (
    <ThreadAgentsSheetFrame navigation={navigation}>
      <Text className="pt-6 text-center text-sm text-foreground-muted">This conversation is no longer open.</Text>
    </ThreadAgentsSheetFrame>
  );
}

function ThreadAgentsSheetContent(props: { readonly store: ConversationStore; readonly navigation: Navigation }) {
  const { store, navigation } = props;
  const rows = useAgentRoster(store);
  const hostId = store.controller.hostId;
  const open = (sessionId: string) => navigation.dispatch(StackActions.replace("Thread", { hostId, sessionId }));
  return (
    <ThreadAgentsSheetFrame navigation={navigation}>
      {rows.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">No agents in this turn.</Text>
      ) : (
        rows.map((row) => <AgentRow key={row.id} row={row} onOpen={open} onOpenProvider={(itemId) => navigation.dispatch(StackActions.replace("ThreadSubagent", { hostId, conversationId: conversationIdOf(store), itemId }))} className="border-b border-border py-3.5" />)
      )}
    </ThreadAgentsSheetFrame>
  );
}

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

function ThreadAgentsSheetFrame(props: { readonly navigation: Navigation; readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {props.children}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Agents" onBack={() => props.navigation.goBack()} />
      {content}
    </View>
  );
}
