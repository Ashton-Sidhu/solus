<script lang="ts">
  import type { McpTask } from "@solus/contracts/integrations/mcp-task";
  import { mcpTaskItem, MCP_TASK_ANSWER, MCP_TASK_CANCEL } from "@solus/client-core/mcp-task-row";
  import { mcpTasksStore } from "../../contexts/sessions/mcp-tasks.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import BackgroundItemRow from "./BackgroundItemRow.svelte";
  import QuestionCard from "./QuestionCard.svelte";

  /**
   * The session's MCP tasks (docs/plans/mcp-first-class.md §12.5), where its
   * background work shows: one row each, with Cancel, and Answer while the
   * server asks a question. Answer opens the question card that an MCP
   * elicitation uses in a turn, under the row.
   */
  interface Props {
    tabId: string;
    tasks: readonly McpTask[];
  }
  let { tabId, tasks }: Props = $props();

  /** The MCP task whose question is open, by id. */
  let answeringId = $state<string | null>(null);
  const answering = $derived(tasks.find((task) => task.id === answeringId && task.input?.length) ?? null);

  async function act(task: McpTask, actionId: string): Promise<void> {
    if (actionId === MCP_TASK_ANSWER.id) {
      answeringId = answeringId === task.id ? null : task.id;
      return;
    }
    if (actionId !== MCP_TASK_CANCEL.id) return;
    try {
      await mcpTasksStore.cancel(task);
    } catch {
      toasts.error(`The MCP task ${task.tool} could not be cancelled`);
    }
    requestInputFocus({ tabId });
  }

  async function answer(task: McpTask, key: string, answers: Record<string, string>): Promise<boolean> {
    try {
      const taken = await mcpTasksStore.answer(task, key, answers);
      if (!taken) toasts.error("This question is no longer open");
      answeringId = null;
      requestInputFocus({ tabId });
      return taken;
    } catch {
      toasts.error(`The answer could not be sent to ${task.integrationName}`);
      return false;
    }
  }
</script>

{#each tasks as task (task.id)}
  <BackgroundItemRow item={mcpTaskItem(task)} onAction={(actionId) => act(task, actionId)} />
  {#if answering?.id === task.id && answering.input?.[0]}
    {@const question = answering.input[0]}
    {#key question.request.questionId}
      <QuestionCard
        {tabId}
        request={question.request}
        shortcuts={false}
        respond={(_questionId, answers) => answer(task, question.key, answers)}
      />
    {/key}
  {/if}
{/each}
