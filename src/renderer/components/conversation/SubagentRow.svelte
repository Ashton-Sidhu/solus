<script lang="ts">
  import { CheckIcon, WarningCircleIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import type { SubagentRow } from "./lib/subagent-group";

  /**
   * §18 — one row per agent, whether the card holds one agent or a fan-out of
   * them. Everything that varies between agents lives here — model, effort,
   * progress, elapsed — because the header may only carry what they share.
   * Rows are controls, like diff rows: clicking one opens that agent's
   * transcript in the secondary pane, and a row never carries card chrome of
   * its own, because the card is the fan-out.
   */
  interface Props {
    row: SubagentRow;
    tabId: string;
  }
  let { row, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const panes = session.panes;

  const elapsed = $derived(
    row.elapsedMs < 60_000
      ? `${Math.round(row.elapsedMs / 1000)}s`
      : `${Math.floor(row.elapsedMs / 60_000)}m ${Math.round((row.elapsedMs % 60_000) / 1000)}s`,
  );
  // The agent's plan gives the rail its denominator; without one only the tool
  // calls it has run are knowable, so the count prints bare.
  const steps = $derived(
    row.steps.total > 0
      ? `${row.steps.done}/${row.steps.total}`
      : row.steps.done || "",
  );
  const isOpen = $derived(
    panes.secondaryOverlay?.kind === "subagent" &&
      panes.secondaryOverlay.messageId === row.id,
  );
</script>

<button
  type="button"
  class="subagent-row"
  class:is-open={isOpen}
  aria-label={`${row.name}, ${row.activity}`}
  aria-current={isOpen ? "true" : undefined}
  data-testid="subagent-card"
  data-state={row.state}
  onclick={() => panes.openSubagent(tabId, row.id)}
>
  <span class="subagent-row__glyph" aria-hidden="true">
    {#if row.state === "running"}
      <span class="subagent-row__spinner"></span>
    {:else if row.state === "failed"}
      <WarningCircleIcon size={12} weight="regular" />
    {:else}
      <CheckIcon size={12} weight="bold" />
    {/if}
  </span>

  <span class="subagent-row__name">{row.name}</span>

  <span
    class="subagent-row__activity"
    class:is-shimmering={row.state === "running"}
    class:is-muted={row.state !== "running"}
  >
    {row.activity}
  </span>

  {#if row.target}
    <span class="subagent-row__target font-mono">{row.target}</span>
  {/if}

  <span class="flex-1"></span>

  {#if row.meta}
    <span class="subagent-row__meta font-mono">{row.meta}</span>
  {/if}
  <span class="subagent-row__rail subagent-row__rail--steps font-mono">{steps}</span>
  <span class="subagent-row__rail subagent-row__rail--time font-mono">{elapsed}</span>
</button>

<style>
  .subagent-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0.375rem;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .subagent-row:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  .subagent-row:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.125rem;
  }

  /* The open agent keeps a ring rather than a fill, so the pane's target stays
     obvious without the row reading as selected-and-destructive. */
  .subagent-row.is-open,
  .subagent-row.is-open:hover {
    background: color-mix(in oklch, var(--primary) 6%, transparent);
    box-shadow: inset 0 0 0 0.03125rem color-mix(in oklch, var(--primary) 32%, transparent);
  }

  .subagent-row__glyph {
    display: inline-flex;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
  }

  .subagent-row[data-state="done"] .subagent-row__glyph {
    color: color-mix(in oklch, var(--solus-art-3) 62%, var(--foreground));
  }

  .subagent-row[data-state="failed"] .subagent-row__glyph {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
  }

  /* The name is the only thing that lets a reader act on a row, so it never
     truncates — the activity beside it gives way instead. */
  .subagent-row__name {
    flex-shrink: 0;
    font-size: 0.78125rem;
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .subagent-row__activity {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
  }

  .subagent-row__activity.is-muted {
    color: var(--muted-foreground);
  }

  .subagent-row__target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.6875rem;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  /* Dispatch, not progress: it sits a step dimmer than the rails so the eye
     reads what the agent is doing before what it was dispatched with. */
  .subagent-row__meta {
    flex-shrink: 0;
    font-size: 0.625rem;
    color: var(--muted-foreground);
    opacity: 0.5;
    white-space: nowrap;
  }

  .subagent-row__rail {
    flex-shrink: 0;
    font-size: 0.65625rem;
    color: var(--muted-foreground);
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .subagent-row__rail--steps {
    width: 1.875rem;
  }

  .subagent-row__rail--time {
    width: 2.125rem;
  }

  /* Live reads as a sentence in progress; a settled row stops moving. */
  .subagent-row__activity.is-shimmering {
    background: linear-gradient(
      90deg,
      var(--muted-foreground) 30%,
      var(--foreground) 50%,
      var(--muted-foreground) 70%
    );
    /* Matches the transcript sweep: a fixed-width tile travelled exactly once
       per cycle, so the loop never seams and the phase does not jump when the
       activity label changes length. */
    background-size: 12rem 100%;
    background-repeat: repeat;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: subagent-shim 2.4s linear infinite;
  }

  .subagent-row__spinner {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    border: 0.09375rem solid color-mix(in oklch, var(--foreground) 14%, transparent);
    border-top-color: var(--muted-foreground);
    animation: subagent-spin 0.8s linear infinite;
  }

  @keyframes subagent-shim {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 12rem 0;
    }
  }

  @keyframes subagent-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .subagent-row__activity.is-shimmering {
      animation: none;
      background: none;
      -webkit-text-fill-color: var(--muted-foreground);
      color: var(--muted-foreground);
    }
    .subagent-row__spinner {
      animation: none;
    }
  }
</style>
