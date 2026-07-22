<script lang="ts">
  import {
    ArrowsInSimpleIcon,
    ArrowsOutSimpleIcon,
    RobotIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { parseSubagentInput } from "./lib/subagent";
  import SubagentTranscript from "./SubagentTranscript.svelte";

  interface Props {
    tabId: string;
    messageId: string;
    onClose: () => void;
    onToggleMaximize?: () => void;
  }
  let { tabId, messageId, onClose, onToggleMaximize }: Props = $props();

  const session = getWorkspaceContext();
  const panes = session.panes;

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

  const headerButton =
    "flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)";
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
>
  <header
    class="flex h-(--solus-chrome-row-h,var(--solus-tap-target-lg)) shrink-0 items-center gap-2 border-b border-(--solus-chrome-row-border,var(--solus-container-border)) px-3"
  >
    <span
      class="shrink-0 text-(--solus-accent)"
      aria-hidden="true"
    >
      <RobotIcon size={15} weight="regular" />
    </span>
    <div class="flex min-w-0 flex-1 items-baseline gap-2">
      <span
        class="shrink-0 text-[0.6875rem] font-[560] text-(--solus-accent)"
        >{subagentType}</span
      >
      <span
        class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
      >
        {task}
      </span>
      {#if isRunning}
        <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Running…</span
        >
      {:else if isError}
        <span class="shrink-0 text-xs text-(--solus-art-negative)">Failed</span>
      {/if}
    </div>
    {#if onToggleMaximize}
      <button
        type="button"
        class={headerButton}
        aria-label={panes.maximized ? "Restore panel" : "Maximize panel"}
        onclick={onToggleMaximize}
        use:tooltip={panes.maximized ? "Restore" : "Maximize"}
      >
        {#if panes.maximized}
          <ArrowsInSimpleIcon size={13} weight="bold" />
        {:else}
          <ArrowsOutSimpleIcon size={13} weight="bold" />
        {/if}
      </button>
    {/if}
    <button
      type="button"
      class={headerButton}
      aria-label="Close sub-agent panel"
      onclick={onClose}
      use:tooltip={"Close"}
    >
      <XIcon size={13} weight="bold" />
    </button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if message}
      <SubagentTranscript {message} />
    {:else}
      <div class="px-4 py-6 text-sm text-(--solus-text-tertiary)">
        This sub-agent is no longer available.
      </div>
    {/if}
  </div>
</div>
