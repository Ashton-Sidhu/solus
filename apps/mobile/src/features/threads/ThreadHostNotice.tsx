import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import {
  pullRequestWatchWake,
  pullRequestWatchWakeMarks,
  pullRequestWatchWakeSummary,
} from "@solus/client-core/pull-request-watch-wake";
import { backgroundCommandWake, backgroundCommandWakeSummary } from "@solus/client-core/background-command-wake";
import { mcpTaskWake } from "@solus/contracts/integrations/mcp-task";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { TerminalOutput } from "../../components/TerminalOutput";
import type { ConversationStore } from "../conversation/conversation-store";
import { PullRequestWatchMarks } from "./PullRequestWatchMarks";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { UserMessageRow } from "./ThreadUserMessageRow";
import { useTranscriptItem } from "./use-transcript-items";
import { WorkLogBlock, WorkLogIconSlot, WorkLogPressable } from "./work-log-layout";

/**
 * A host-sent caption, as desktop draws it (`HostNoticeRow`): one work-log row
 * with a glyph, a fixed label and the news in a few words, the full text
 * behind a press. The icon alone takes a colour, and only when the news needs
 * the agent. The wake starts a turn, as a prompt does, so the row sits on the
 * prompts' side, at the right.
 */
function HostNoticeRow(props: {
  readonly label: string;
  readonly summary: string;
  /** Drawn in place of the summary while the row is folded: the news as
   *  icons. The accessibility label keeps the summary in words. */
  readonly marks?: ReactNode;
  readonly attention: boolean;
  readonly icon: AppSymbolName;
  readonly text: string;
  /** The folded body as a sentence and terminal output, in place of the text
   *  as markdown: a command's output keeps every line and reads in mono. */
  readonly terminal?: { readonly line: string; readonly output: string | null };
  /** The folded body as plain text, in place of the text as markdown: a server's data (an MCP task's result) is never markdown. */
  readonly plain?: string;
  readonly store: ConversationStore;
  readonly iconSubtleColor: ColorValue;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <WorkLogBlock>
      <WorkLogPressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${props.label}, ${props.summary}`}
        onPress={() => setExpanded((value) => !value)}
      >
        <View className="flex-1 items-end py-1">
          <View className="max-w-full flex-row items-center gap-1.5">
            <WorkLogIconSlot>
              <SymbolView
                name={props.attention ? "exclamationmark.circle" : props.icon}
                size={14}
                weight="medium"
                {...(props.attention
                  ? { tintColorClassName: "accent-danger-foreground" }
                  : { tintColor: props.iconSubtleColor })}
                type="monochrome"
              />
            </WorkLogIconSlot>
            <Text className="shrink-0 text-sm text-foreground-muted">{props.label}</Text>
            {expanded || !props.summary ? null : props.marks ? (
              props.marks
            ) : (
              <Text className="min-w-0 shrink text-sm text-foreground-muted opacity-70" numberOfLines={1}>
                {props.summary}
              </Text>
            )}
          </View>
          {expanded ? (
            <View className="mt-1 w-[85%]">
              {props.terminal ? (
                <>
                  <Text className="text-sm leading-normal text-foreground">{props.terminal.line}</Text>
                  {props.terminal.output ? (
                    <View className="mt-2">
                      <TerminalOutput output={props.terminal.output} label={`Output, ${props.label}`} />
                    </View>
                  ) : null}
                </>
              ) : props.plain !== undefined ? (
                <Text className="text-sm leading-normal text-foreground" selectable>{props.plain}</Text>
              ) : (
                <ThreadMarkdown markdown={props.text} tone="user" store={props.store} />
              )}
            </View>
          ) : null}
        </View>
      </WorkLogPressable>
    </WorkLogBlock>
  );
}

/** A person's prompt as a bubble, or the host's own caption as a notice row. */
export const UserTurnRow = memo(function UserTurnRow(props: ComponentProps<typeof UserMessageRow>) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "user") return null;
  // Known by its text: a history row keeps no origin. A held prompt is the person's.
  const sent = item.delivery === "sent";
  const watch = sent ? pullRequestWatchWake(item.text) : null;
  if (watch) {
    const words = pullRequestWatchWakeSummary(watch);
    return (
      <HostNoticeRow
        label="Pull request watch"
        summary={`#${watch.number}${words ? ` · ${words}` : ""}`}
        marks={<PullRequestWatchMarks wake={watch} marks={pullRequestWatchWakeMarks(watch)} />}
        attention={watch.attention}
        icon="eye"
        text={item.text}
        store={props.store}
        iconSubtleColor={props.iconSubtleColor}
      />
    );
  }
  const command = sent ? backgroundCommandWake(item.text) : null;
  if (command) {
    return (
      <HostNoticeRow
        label="Background command"
        summary={`${command.command} · ${backgroundCommandWakeSummary(command)}`}
        attention={command.attention}
        icon="terminal"
        text={item.text}
        terminal={{
          line: command.exitCode === null
            ? `${command.command} finished after the turn ended.`
            : `${command.command} finished after the turn ended with exit ${command.exitCode}.`,
          output: command.output,
        }}
        store={props.store}
        iconSubtleColor={props.iconSubtleColor}
      />
    );
  }
  const mcpTask = sent ? mcpTaskWake(item.text) : null;
  if (mcpTask) {
    return (
      <HostNoticeRow
        label="MCP task"
        summary={`${mcpTask.label} · ${mcpTask.outcome}`}
        attention={mcpTask.outcome === "failed"}
        icon="timer"
        text={item.text}
        plain={mcpTask.body}
        store={props.store}
        iconSubtleColor={props.iconSubtleColor}
      />
    );
  }
  return <UserMessageRow {...props} />;
});

/** A prompt the host sent as a caption, known by its text: a history row keeps no origin. */
export function isHostNotice(text: string): boolean {
  return !!(pullRequestWatchWake(text) || backgroundCommandWake(text) || mcpTaskWake(text));
}
