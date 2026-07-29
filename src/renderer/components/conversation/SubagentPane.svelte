<script lang="ts">
  import { RobotIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { parseSubagentInput } from "./lib/subagent";
  import SubagentTranscript from "./SubagentTranscript.svelte";

  interface Props {
    tabId: string;
    messageId: string;
  }
  let { tabId, messageId }: Props = $props();

  const session = getWorkspaceContext();

  const message = $derived(
    session.sessionFor(tabId)?.messages.find((m) => m.id === messageId),
  );

  const parsedInput = $derived(parseSubagentInput(message?.toolInput));
  const subagentType = $derived(
    message?.subagentType || parsedInput.subagent_type || "agent",
  );
  const task = $derived(
    (parsedInput.description || parsedInput.prompt || "Sub-agent").trim(),
  );
  // toolStatus tracks the agent (see SubagentCard); toolResult only says whether
  // the tool call answered, which a backgrounded agent does before it starts work.
  const isRunning = $derived(message?.toolStatus === "running");
  const isError = $derived(
    !!message?.toolResultIsError || message?.toolStatus === "error",
  );
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <!-- Identity reads as the transcript's lead block, so it scrolls away with
         the run instead of pinning a second chrome row under the top rail. The
         right gutter clears the pane's floating chrome cluster. -->
    <div
      class="flex items-baseline gap-2 pt-3 pb-2 pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
    >
      <span class="shrink-0 self-center text-(--solus-accent)" aria-hidden="true">
        <RobotIcon size={15} weight="regular" />
      </span>
      <span class="shrink-0 text-[0.6875rem] font-[560] text-(--solus-accent)"
        >{subagentType}</span
      >
      <span
        class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
      >
        {task}
      </span>
      {#if isRunning}
        <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Running…</span>
      {:else if isError}
        <span class="shrink-0 text-xs text-(--solus-art-negative)">Failed</span>
      {/if}
    </div>

    {#if message}
      <SubagentTranscript {message} />
    {:else}
      <div class="px-4 py-6 text-sm text-(--solus-text-tertiary)">
        This sub-agent is no longer available.
      </div>
    {/if}
  </div>
</div>
