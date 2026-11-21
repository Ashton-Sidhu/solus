import { useState } from "react";
import { MCP_TASK_ANSWER } from "@solus/client-core/mcp-task-row";
import { useListened } from "../../app/app-context";
import type { ConversationStore } from "../conversation/conversation-store";
import type { McpTasksFeed } from "../conversation/session-records-feed";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ThreadBackgroundWork } from "./ThreadBackgroundWork";

/**
 * The thread's MCP tasks above the composer (docs/plans/mcp-first-class.md
 * §12.5), with the stop control, and Answer while the server asks. Answer
 * opens the question card that the agent's questions use.
 */
export function ThreadMcpTasks(props: {
  readonly feed: McpTasksFeed;
  /** The newest turn's start: a task that ended before it shows no row. */
  readonly since: number;
  readonly store: ConversationStore;
  readonly mayDrive: boolean;
  readonly maxHeight: number;
}) {
  const { feed } = props;
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  // A task that asks is live, so it has a row.
  const answering = useListened(feed.changes, () => feed.list.find((task) => task.id === answeringId && task.input?.length) ?? null);
  const question = answering?.input?.[0] ?? null;
  return (
    <ThreadBackgroundWork
      feed={feed}
      since={props.since}
      mayDrive={props.mayDrive}
      onAction={(task, actionId) => {
        if (actionId !== MCP_TASK_ANSWER.id) return feed.cancel(task);
        setAnsweringId((current) => (current === task.id ? null : task.id));
        return undefined;
      }}
    >
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
            await feed.answer(answering, question.key, answers);
            setAnsweringId(null);
          }}
          onUnsentRemarks={props.store.returnRemarksToDraft}
        />
      ) : null}
    </ThreadBackgroundWork>
  );
}
