<script lang="ts">
  import { RobotIcon } from "phosphor-svelte";
  import type { Message } from "../../../shared/types";
  import SubagentCard from "./SubagentCard.svelte";

  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  const isBatch = $derived(messages.length > 1);
  const runningCount = $derived(
    messages.filter((message) => message.toolResult === undefined).length,
  );
  const failedCount = $derived(
    messages.filter(
      (message) =>
        message.toolResult !== undefined && !!message.toolResultIsError,
    ).length,
  );
  const completeCount = $derived(
    messages.length - runningCount - failedCount,
  );
  const summary = $derived(
    [
      runningCount > 0 ? `${runningCount} working` : "",
      completeCount > 0 ? `${completeCount} complete` : "",
      failedCount > 0 ? `${failedCount} failed` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <section
    class="subagent-group mx-auto w-[88%] max-w-[46rem] overflow-hidden rounded-[0.875rem]"
    aria-label={isBatch ? `${messages.length} sub-agents` : "Sub-agent"}
    data-testid="subagent-group"
  >
    {#if isBatch}
      <header class="flex h-9 items-center gap-2 px-3">
        <span class="text-(--solus-accent)" aria-hidden="true">
          <RobotIcon size={14} weight="regular" />
        </span>
        <span class="text-[0.6875rem] font-[560] text-(--solus-text-secondary)">
          Sub-agents
        </span>
        <span
          class="ml-auto text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums"
        >
          {summary}
        </span>
      </header>
    {/if}

    <div class:subagent-group__rows={isBatch}>
      {#each messages as message (message.id)}
        <div class="subagent-group__row">
          <SubagentCard {message} {tabId} />
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .subagent-group {
    background: color-mix(
      in srgb,
      var(--solus-container-bg) 95%,
      white
    );
    box-shadow:
      0 0 0 0.0625rem
        color-mix(in srgb, var(--solus-tool-border) 72%, transparent),
      0 0.0625rem 0.125rem -0.0625rem
        color-mix(in srgb, black 10%, transparent),
      0 0.25rem 0.75rem -0.625rem
        color-mix(in srgb, black 18%, transparent);
  }

  .subagent-group__rows {
    border-top: 0.0625rem solid
      color-mix(in srgb, var(--solus-tool-border) 64%, transparent);
  }

  .subagent-group__row + .subagent-group__row {
    border-top: 0.0625rem solid
      color-mix(in srgb, var(--solus-tool-border) 52%, transparent);
  }

  @media (max-width: 40rem) {
    .subagent-group {
      width: calc(100% - 1rem);
    }
  }
</style>
