<script lang="ts">
  import {
    CaretRightIcon,
    CheckIcon,
    SpinnerGapIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type { Message } from "../../../shared/types";
  import { prettyToolName } from "../../contexts/workspace/session.utils";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import { formatActivityDuration } from "./lib/activity-summary";
  import {
    toolTraceInput,
    toolTraceOutput,
    toolTraceStatus,
  } from "./lib/tool-trace";

  interface Props {
    tool: Message;
  }
  let { tool }: Props = $props();

  let expanded = $state(false);
  const input = $derived(toolTraceInput(tool));
  const output = $derived(toolTraceOutput(tool));
  const status = $derived(toolTraceStatus(tool));
  const isError = $derived(status === "Failed");
  const hasDetails = $derived(Boolean(input || output || tool.toolId));
  const duration = $derived(
    tool.toolCompletedAt
      ? formatActivityDuration(tool.toolCompletedAt - tool.timestamp)
      : "",
  );
</script>

<div class="trace-call" class:is-open={expanded}>
  <button
    type="button"
    class="trace-call__summary active:scale-[0.96]"
    disabled={!hasDetails}
    aria-expanded={hasDetails ? expanded : undefined}
    onclick={() => {
      if (hasDetails) expanded = !expanded;
    }}
  >
    <span class="trace-call__caret" aria-hidden="true">
      {#if hasDetails}
        <CaretRightIcon
          size={11}
          class="transition-transform {expanded ? 'rotate-90' : ''}"
        />
      {/if}
    </span>
    <span
      class="trace-call__state"
      class:is-failed={status === "Failed"}
      aria-hidden="true"
    >
      {#if status === "Running"}
        <SpinnerGapIcon size={11} class="animate-spin" />
      {:else if status === "Failed"}
        <WarningCircleIcon size={11} />
      {:else}
        <CheckIcon size={11} weight="bold" />
      {/if}
    </span>
    <span class="min-w-0 truncate font-mono text-[0.71875rem]">
      {tool.toolName || "Tool"}
    </span>
    <span class="truncate text-[0.71875rem] text-(--muted-foreground)">
      {prettyToolName(tool.toolName || "Tool")}
    </span>
    <span class="flex-1"></span>
    <span class="font-mono text-[0.625rem] text-(--muted-foreground) tabular-nums opacity-60">
      {status}{#if duration} · {duration}{/if}
    </span>
  </button>

  {#if expanded}
    <div class="trace-call__detail">
      {#if tool.toolId}
        <div class="trace-call__id">
          <span>Call ID</span>
          <code>{tool.toolId}</code>
        </div>
      {/if}
      {#if input}
        <section aria-label="Tool input">
          <h4>Input</h4>
          <CodeBlock text={input.text} lang={input.language} />
        </section>
      {/if}
      {#if output}
        <section aria-label={isError ? "Tool error" : "Tool output"}>
          <h4 class:is-error={isError}>
            {isError ? "Error" : "Output"}
          </h4>
          <CodeBlock text={output.text} lang={output.language} />
        </section>
      {:else if status === "Running"}
        <p class="m-0 text-[0.71875rem] text-(--muted-foreground)">
          Waiting for output…
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .trace-call {
    border-radius: 0.5rem;
  }

  .trace-call.is-open {
    background: color-mix(in oklch, var(--foreground) 2.5%, transparent);
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 9%, transparent);
  }

  .trace-call__summary {
    display: flex;
    width: 100%;
    min-height: 2.5rem;
    align-items: center;
    gap: 0.5625rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    padding: 0.4375rem 0.625rem;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .trace-call__summary:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  .trace-call__summary:disabled {
    cursor: default;
  }

  .trace-call__summary:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.125rem;
  }

  .trace-call__caret,
  .trace-call__state {
    display: inline-flex;
    width: 0.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    opacity: 0.55;
  }

  .trace-call__state.is-failed {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
    opacity: 1;
  }

  .trace-call__detail {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 0.25rem 0.625rem 0.75rem 2.5rem;
  }

  .trace-call__detail h4 {
    margin: 0 0 0.375rem;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--muted-foreground);
    text-transform: uppercase;
  }

  .trace-call__detail h4.is-error {
    color: color-mix(in oklch, var(--destructive) 72%, var(--foreground));
  }

  .trace-call__id {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.625rem;
    font-size: 0.625rem;
    color: var(--muted-foreground);
  }

  .trace-call__id code {
    overflow: hidden;
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }
</style>
