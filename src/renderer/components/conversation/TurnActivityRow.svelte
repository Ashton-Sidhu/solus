<script lang="ts">
  import { ArrowCounterClockwiseIcon, WarningCircleIcon } from "phosphor-svelte";
  import ActivityRow from "./ActivityRow.svelte";
  import { KIND_ICONS } from "./lib/activity-icons";
  import {
    activityKinds,
    formatActivityDuration,
    getToolDescription,
    liveActivityLabel,
    participleFor,
    toolPathsFromParsed,
  } from "./lib/activity-summary";
  import {
    hasVisibleTurnBody,
    turnDurationMs,
    type Turn,
  } from "./lib/turns";
  import type { TurnStartKind } from "../../../shared/types";

  /**
   * §16 — one row per turn, and never two. The live row and the summary row are
   * the same row: it rewrites itself in place when the turn ends, so a running
   * indicator and a finished summary can never appear stacked. §17's failure is
   * the one ending it takes on itself, keeping the row's geometry and adding the
   * complete error, retry context, and one button.
   *
   * A stop and a no-reply are not endings this row describes — they are events
   * that closed the turn, and TurnEndDivider reports them after the turn's
   * content. So the row keeps summarising and disclosing the work either way:
   * being stopped never costs the reader the transcript of what ran.
   */
  interface Props {
    turn: Turn;
    /** This turn is the tail of the transcript and the session is still on it. */
    live: boolean;
    /** Session lifecycle label while no tool is reporting more specific work. */
    activityLabel?: string;
    turnStart?: TurnStartKind | null;
    expanded: boolean;
    /** Retries past the first; printed on the rail beside the run time. */
    attempt?: number;
    onToggle: () => void;
    onRetry?: () => void;
  }

  let {
    turn,
    live,
    activityLabel,
    turnStart = null,
    expanded,
    attempt = 1,
    onToggle,
    onRetry,
  }: Props = $props();

  // Three states, because a stop and a no-reply say nothing about the work the
  // row reports — the run did what it did, and then it was cut short. Their
  // divider states the ending below, in the order the two things happened.
  const state = $derived(
    live ? "live" : turn.end?.kind === "failed" ? "failed" : "done",
  );
  // A turn with nothing folded away keeps the chevron's slot — for the
  // geometry — but has nothing to open.
  // The error is part of the failed row now, not hidden detail. Only actual
  // activity beneath the row earns a disclosure caret.
  const canExpand = $derived(hasVisibleTurnBody(turn));
  const kinds = $derived(activityKinds(turn.tools));

  const runningTool = $derived(turn.tools.find((t) => t.toolStatus === "running"));
  // Steps that have actually landed — a tool still in flight is the row's
  // subject, not something folded away behind it.
  const steps = $derived(turn.tools.filter((t) => t.toolStatus !== "running").length);
  // A request in flight with nothing back yet is waiting, not working — §12's
  // distinction survives the merge into this row: dots, not a spinner, and the
  // label holds still because nothing is happening.
  const waiting = $derived(live && !runningTool);

  let now = $state(Date.now());
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const settledDurationMs = $derived(turnDurationMs(turn));
  const durationMs = $derived(
    live ? Math.max(0, now - turn.startedAt) : settledDurationMs,
  );
  const duration = $derived(
    durationMs === null ? "" : formatActivityDuration(durationMs),
  );

  const liveLabel = $derived(
    runningTool
      ? participleFor(runningTool.toolName)
      : liveActivityLabel(
          activityLabel,
          durationMs ?? 0,
          turn.tools.length > 0,
          turnStart,
        ),
  );
  const liveTarget = $derived.by(() => {
    if (!runningTool) return "";
    const raw = getToolDescription(
      runningTool.toolName || "Tool",
      runningTool.toolInput,
    );
    // The participle already carries the verb, so drop the description's own.
    return raw.replace(/^(Read|Edit|Write|Search files|Search|Fetch)[:\s]+/i, "").trim();
  });

  const filesTouched = $derived.by(() => {
    if (!turn.end) return 0;
    const paths = new Set<string>();
    for (const tool of turn.tools) {
      if (!tool.toolInput) continue;
      try {
        for (const path of toolPathsFromParsed(JSON.parse(tool.toolInput))) paths.add(path);
      } catch {}
    }
    return paths.size;
  });

  // §17 — the same words on whichever surface fired, so there is one retry
  // pattern to learn.
  const RETRY_LABEL = "Retry from your message";
</script>

{#snippet liveTargetText()}{liveTarget}{/snippet}

{#snippet rowRetry()}
  <button type="button" class="turn-action" onclick={onRetry}>
    <ArrowCounterClockwiseIcon size={11} />{RETRY_LABEL}
  </button>
{/snippet}

<ActivityRow
  {expanded}
  onToggle={canExpand ? onToggle : undefined}
  stacked={state === "failed"}
  glyphClass={state === "failed" ? "is-destructive" : ""}
  target={state === "live" && liveTarget ? liveTargetText : undefined}
  actions={state === "failed" && onRetry ? rowRetry : undefined}
  testid="turn-row-{state}"
>
  {#snippet glyph()}
    {#if state === "live"}
      {#if waiting}
        <span class="activity-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      {:else}
        <span class="activity-spinner" aria-hidden="true"></span>
      {/if}
    {:else if state === "failed"}
      <WarningCircleIcon size={14} />
    {:else}
      {#each kinds as kind (kind)}
        {@const Glyph = KIND_ICONS[kind]}
        <Glyph size={14} />
      {/each}
    {/if}
  {/snippet}

  {#snippet label()}
    {#if state === "live"}
      <span class:activity-shimmer={!waiting}>{liveLabel}</span>
    {:else if state === "done"}
      Worked{duration ? " for " : ""}<span class="turn-figure">{duration}</span>
    {:else}
      <!-- The error belongs inside this failed surface; the disclosure only
           controls visible activity that led to it. Retry semantics already
           live on the button, so the card does not repeat them. -->
      <span class="turn-lines">
        <span class="turn-ended-label">Failed</span>
        {#if turn.end?.detail}
          <span class="turn-error">{turn.end.detail}</span>
        {/if}
        {#if filesTouched > 0}
          <span class="turn-survived font-mono"
            >{filesTouched} file{filesTouched === 1 ? "" : "s"} changed</span
          >
        {/if}
      </span>
    {/if}
  {/snippet}

  <!-- §16 — the rail counts, it never narrates: steps, then time. The count is
       the only thing that says how much is folded behind the chevron. -->
  {#snippet rail()}
    {#if attempt > 1}
      <span>attempt {attempt}</span>
    {/if}
    {#if steps > 0}
      <span>{steps} step{steps === 1 ? "" : "s"}</span>
    {/if}
    {#if state !== "done"}
      <span class="activity-rail-time">{duration}</span>
    {/if}
  {/snippet}
</ActivityRow>

<style>
  /* The duration is the one figure worth scanning in a finished turn. */
  .turn-figure {
    color: var(--solus-text-primary);
  }

  .turn-lines {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
  }

  .turn-ended-label {
    color: var(--solus-text-primary);
  }

  .turn-survived {
    font-size: 0.6875rem;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .turn-error {
    max-width: 100%;
    color: var(--solus-text-primary);
    font-size: 0.78125rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  /* §17's other surface takes the same ghost control as the divider's, sized for
     the row's action slot. */
  .turn-action {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 0.375rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    padding: 0.1875rem 0.5625rem;
    color: var(--solus-text-primary);
    font-size: 0.71875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .turn-action:hover {
    background: color-mix(in oklch, var(--foreground) 10%, transparent);
  }

  .turn-action:active {
    scale: 0.96;
  }

  .turn-action:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

</style>
