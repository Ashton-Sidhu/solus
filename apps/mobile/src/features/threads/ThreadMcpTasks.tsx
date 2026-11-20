import { useState } from "react";
import { ActivityIndicator, Pressable, View, type ColorValue } from "react-native";
import type { BackgroundItem } from "@solus/client-core/background-item";
import { mcpTaskItem, MCP_TASK_ANSWER } from "@solus/client-core/mcp-task-row";
import type { McpTask } from "@solus/contracts/integrations/mcp-task";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ConversationStore } from "../conversation/conversation-store";
import { formatWorkingDuration } from "./floating-working-status";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import type { McpTasksView } from "./use-mcp-tasks";

/**
 * The thread's MCP tasks above the composer, as desktop shows them under the
 * last turn (docs/plans/mcp-first-class.md §12.5): one row each, in the work
 * log's row style (`HostNoticeRow`), with Cancel, and Answer while the server
 * asks. Answer opens the question card that the agent's questions use.
 */
export function ThreadMcpTasks(props: {
  readonly view: McpTasksView;
  readonly store: ConversationStore;
  readonly mayDrive: boolean;
  readonly maxHeight: number;
}) {
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const answering = props.view.tasks.find((task) => task.id === answeringId && task.input?.length) ?? null;
  const question = answering?.input?.[0] ?? null;
  if (!props.view.tasks.length) return null;
  const act = (task: McpTask, actionId: string) => {
    if (actionId === MCP_TASK_ANSWER.id) {
      setAnsweringId((current) => (current === task.id ? null : task.id));
      return;
    }
    const key = `${task.id}:${actionId}`;
    setBusyKey(key);
    void props.view.cancel(task).catch(() => undefined).finally(() => setBusyKey((current) => (current === key ? null : current)));
  };
  return (
    <View className="shrink-0 gap-1 px-4 pb-2">
      {props.view.tasks.map((task) => (
        <McpTaskRow
          key={task.id}
          item={mcpTaskItem(task)}
          mayDrive={props.mayDrive}
          busyActionId={busyKey?.startsWith(`${task.id}:`) ? busyKey.slice(task.id.length + 1) : null}
          iconSubtleColor={iconSubtleColor}
          onAction={(actionId) => act(task, actionId)}
        />
      ))}
      {answering && question ? (
        <PendingUserInputCard
          key={question.request.questionId}
          pendingUserInput={question.request}
          store={props.store}
          maxHeight={props.maxHeight}
          collapsed={false}
          onToggleCollapsed={() => setAnsweringId(null)}
          responding={false}
          mayDrive={props.mayDrive}
          onSubmit={async (answers) => {
            await props.view.answer(answering, question.key, answers);
            setAnsweringId(null);
          }}
          onUnsentRemarks={props.store.returnRemarksToDraft}
        />
      ) : null}
    </View>
  );
}

function McpTaskRow(props: {
  readonly item: BackgroundItem;
  readonly mayDrive: boolean;
  readonly busyActionId: string | null;
  readonly iconSubtleColor: ColorValue;
  readonly onAction: (actionId: string) => void;
}) {
  const { item } = props;
  const nowMs = useVisibleSecondClock(item.startedAt !== null);
  return (
    <View className="min-h-9 flex-row items-center gap-1.5" accessibilityLabel={`${item.label}, ${item.detail}`}>
      <View className="w-5 items-center">
        {item.state === "running" ? (
          <ActivityIndicator size="small" color={props.iconSubtleColor} />
        ) : (
          <SymbolView
            name={item.state === "ended" ? "checkmark" : item.state === "stopped" ? "minus" : "exclamationmark.circle"}
            size={14}
            weight="medium"
            {...(item.state === "failed" ? { tintColorClassName: "accent-danger-foreground" } : { tintColor: props.iconSubtleColor })}
            type="monochrome"
          />
        )}
      </View>
      <Text className="shrink-0 text-sm text-foreground-muted" numberOfLines={1}>{item.label}</Text>
      <Text className="min-w-0 flex-1 text-sm text-foreground-muted opacity-70" numberOfLines={1}>{item.detail}</Text>
      {item.startedAt !== null ? (
        <Text className="text-xs text-foreground-muted opacity-60">{formatWorkingDuration(item.startedAt, nowMs)}</Text>
      ) : null}
      {item.actions.map((action) => (
        <Pressable
          key={action.id}
          accessibilityRole="button"
          accessibilityLabel={`${action.label}, ${item.label}`}
          disabled={!props.mayDrive || props.busyActionId !== null}
          onPress={() => props.onAction(action.id)}
          hitSlop={8}
          className="h-8 justify-center rounded-full px-2.5 active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-sm font-t3-bold text-foreground">{props.busyActionId === action.id ? action.busyLabel : action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
