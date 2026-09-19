<script lang="ts">
  import { Check as CheckIcon, CircleAlert as WarningCircleIcon } from "@lucide/svelte";
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
  const router = session.router;

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
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
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
  onclick={() => session.openSubagent(tabId, row.id)}
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

  <!-- Same anatomy as the run card: the name leads on its own line and the step
       in flight sits under it, so the two never fight for one line and the
       name stays whole while the activity truncates. -->
  <span class="subagent-row__body">
    <span class="subagent-row__name">{row.name}</span>
    <span class="subagent-row__detail">
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
    </span>
  </span>

  <!-- The rail is the first thing to give in a narrow pane: dispatch facts
       drop before the figures, and the figures never drop. -->
  <span class="subagent-row__rails">
    {#if row.meta}
      <span class="subagent-row__meta @max-[30rem]/pane:hidden">{row.meta}</span>
    {/if}
    <span class="subagent-row__rail subagent-row__rail--steps">{steps}</span>
    <span class="subagent-row__rail subagent-row__rail--time">{elapsed}</span>
  </span>
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

  /* The body owns the flexible middle; everything inside it truncates and
     nothing outside it does, so the rails always land. */
  .subagent-row__body {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* The name is the only thing that lets a reader act on a row, so it gets
     the whole line — the activity under it gives way instead. */
  .subagent-row__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-transcript-card);
    font-weight: 500;
    line-height: 1.25;
    color: var(--solus-text-primary);
  }

  .subagent-row__detail {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.4375rem;
    font-size: var(--text-transcript-meta);
  }

  .subagent-row__activity {
    flex-shrink: 0;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subagent-row__activity.is-muted {
    color: var(--muted-foreground);
  }

  .subagent-row__target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .subagent-row__rails {
    display: flex;
    flex-shrink: 0;
    align-items: baseline;
    gap: 0.6875rem;
    font-size: var(--text-transcript-meta);
  }

  /* Dispatch, not progress: it sits a step dimmer than the rails so the eye
     reads what the agent is doing before what it was dispatched with. */
  .subagent-row__meta {
    color: var(--muted-foreground);
    opacity: 0.5;
    white-space: nowrap;
  }

  /* Each figure is locked to its own box so ticking digits never nudge the
     rail; the box is a floor, so a long figure widens it instead of spilling
     past the card edge. */
  .subagent-row__rail {
    color: var(--muted-foreground);
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .subagent-row__rail--steps {
    min-width: 1.875rem;
  }

  .subagent-row__rail--time {
    min-width: 3.25rem;
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
    border-radius: 9999px;
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
