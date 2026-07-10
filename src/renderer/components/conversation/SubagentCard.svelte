<script lang="ts">
  import { CaretRightIcon } from "phosphor-svelte";
  import {
    MODEL_PROFILES,
    REASONING_EFFORT_LABELS,
    type Message,
    type ReasoningEffort,
  } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { subToolLabel } from "./lib/subagent";

  interface Props {
    message: Message;
    tabId: string;
  }
  let { message, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const av = session.artifactViewer;

  const parsedInput = $derived.by(() => {
    try {
      return JSON.parse(message.toolInput || "{}") as {
        subagent_type?: string;
        description?: string;
        prompt?: string;
        model?: string;
        reasoning_effort?: string;
      };
    } catch {
      return {};
    }
  });
  const subagentType = $derived(
    message.subagentType || parsedInput.subagent_type || "agent",
  );
  const task = $derived(
    (parsedInput.description || parsedInput.prompt || "Sub-agent").trim(),
  );
  const isCodexSubagent = $derived(message.subagentType === "codex");
  const sess = $derived(session.sessionFor(tabId));
  const modelLabel = $derived.by(() => {
    if (parsedInput.model) return parsedInput.model.trim();
    if (isCodexSubagent) {
      const profiles = MODEL_PROFILES["codex"] ?? {};
      return Object.entries(profiles).find(([, p]) => p.isDefault)?.[0] ?? "";
    }
    return (sess?.sessionModel || sess?.modelConfig.modelId || "").trim();
  });
  const reasoningEffort = $derived(
    (
      parsedInput.reasoning_effort ||
      (isCodexSubagent ? "high" : sess?.modelConfig.reasoningEffort) ||
      ""
    ).trim(),
  );
  const reasoningLabel = $derived(
    REASONING_EFFORT_LABELS[reasoningEffort as ReasoningEffort] ??
      reasoningEffort,
  );
  const metadata = $derived(
    [subagentType, modelLabel, reasoningLabel].filter(Boolean),
  );

  const isRunning = $derived(message.toolResult === undefined);
  const isError = $derived(!!message.toolResultIsError);
  const statusLabel = $derived(
    isRunning ? "Working" : isError ? "Failed" : "Complete",
  );
  const statusColor = $derived(
    isRunning
      ? "var(--solus-accent)"
      : isError
        ? "var(--solus-art-negative)"
        : "var(--solus-art-positive)",
  );
  const subs = $derived(message.subMessages ?? []);
  const ticker = $derived.by(() => {
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].role === "tool") return subToolLabel(subs[i]);
    }
    return "Working…";
  });
  const resultSummary = $derived.by(() => {
    const first = (message.toolResult ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!first) return "Done";
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
  });
  const activity = $derived(isRunning ? ticker : resultSummary);
  const isOpen = $derived(
    av.secondary.kind === "subagent" && av.secondary.messageId === message.id,
  );
</script>

<button
  type="button"
  class="subagent-row group flex min-h-13 w-full cursor-pointer items-center gap-2.5 bg-transparent py-2 pr-2 pl-3 text-left hover:bg-(--solus-surface-hover) focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--solus-accent) {isOpen
    ? 'subagent-row--active'
    : ''}"
  aria-label={`${task}, ${statusLabel}`}
  aria-current={isOpen ? "true" : undefined}
  data-testid="subagent-card"
  onclick={() => av.openSubagent(tabId, message.id)}
>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <div
      class="min-w-0 truncate text-[0.8125rem] font-[560] tracking-[-0.006em] text-(--solus-text-primary)"
    >
      {task}
    </div>
    <div class="flex min-w-0 items-center text-[0.6875rem] leading-4">
      <span class="flex min-w-0 shrink-0 items-center text-(--solus-text-tertiary)">
        {#each metadata as item, index (`${index}-${item}`)}
          {#if index > 0}
            <span class="px-1 text-(--solus-tool-border)" aria-hidden="true">·</span>
          {/if}
          <span class="max-w-28 truncate">{item}</span>
        {/each}
      </span>
      <span class="px-1.5 text-(--solus-tool-border)" aria-hidden="true">·</span>
      <span
        class="w-14 shrink-0 font-[560] text-(--subagent-status-color) max-sm:w-auto"
        style:--subagent-status-color={statusColor}
      >
        {statusLabel}
      </span>
      <span class="px-1.5 text-(--solus-tool-border)" aria-hidden="true">—</span>
      <span
        class="min-w-0 truncate text-(--solus-text-secondary)"
        style:color={isError ? "var(--solus-art-negative)" : undefined}
      >
        {activity}
      </span>
    </div>
  </div>

  <CaretRightIcon
    size={13}
    weight="bold"
    aria-hidden="true"
    class="shrink-0 text-(--solus-text-tertiary) opacity-60 transition-[color,opacity,transform] duration-150 ease-(--ease-premium) group-hover:translate-x-0.5 group-hover:text-(--solus-text-secondary) group-hover:opacity-100"
  />
</button>

<style>
  .subagent-row--active {
    background: var(--solus-accent-light);
  }

  @media (max-width: 40rem) {
    .subagent-row {
      min-height: 3rem;
    }
  }
</style>
