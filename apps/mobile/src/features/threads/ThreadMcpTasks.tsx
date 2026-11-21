import { useState } from "react";
import { MCP_TASK_ANSWER, MCP_TASKS } from "@solus/client-core/mcp-task-row";
import type { ConversationStore } from "../conversation/conversation-store";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ThreadBackgroundWork } from "./ThreadBackgroundWork";
import type { McpTasksView } from "./use-mcp-tasks";

/**
 * The thread's MCP tasks above the composer (docs/plans/mcp-first-class.md
 * §12.5), with the stop control, and Answer while the server asks. Answer
 * opens the question card that the agent's questions use.
 */
export function ThreadMcpTasks(props: {
  readonly view: McpTasksView;
  readonly store: ConversationStore;
  readonly mayDrive: boolean;
  readonly maxHeight: number;
}) {
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const answering = props.view.tasks.find((task) => task.id === answeringId && task.input?.length) ?? null;
  const question = answering?.input?.[0] ?? null;
  return (
    <ThreadBackgroundWork
      kind={MCP_TASKS}
      records={props.view.tasks}
      mayDrive={props.mayDrive}
      onAction={(task, actionId) => {
        if (actionId !== MCP_TASK_ANSWER.id) return props.view.cancel(task);
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
            await props.view.answer(answering, question.key, answers);
            setAnsweringId(null);
          }}
          onUnsentRemarks={props.store.returnRemarksToDraft}
        />
      ) : null}
    </ThreadBackgroundWork>
  );
}
