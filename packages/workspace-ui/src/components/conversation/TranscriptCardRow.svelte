<script lang="ts">
  import type { Snippet } from "svelte";
  import { PanelRight as PanelRightIcon } from "@lucide/svelte";
  import { isNestedInteractive } from "./lib/transcript-card";

  /**
   * One row inside a grouped transcript card: sub-agents, a document stack.
   * The same slots as the card line, one step smaller, and no borders between
   * rows. Put it in a `TranscriptCard` with `bodyLayout="rows"`.
   */
  interface Props {
    name: string;
    /** What the row is doing or became: `reading`, `returned 2 findings`. */
    activity?: string;
    /** Sweep the activity while it is live. */
    isLive?: boolean;
    target?: string;
    /** The row's object is open in the companion pane. */
    open?: boolean;
    /** Tint for the glyph slot: `is-done`, `is-failed`, or `is-artifact`. */
    glyphClass?: string;
    ariaLabel?: string;
    secondaryActionLabel?: string;
    "data-testid"?: string;
    "data-state"?: string;
    onOpen?: () => void;
    onOpenSecondary?: () => void;
    glyph: Snippet;
    /** Counts and time only. */
    rail?: Snippet;
  }

  let {
    name,
    activity,
    isLive = false,
    target,
    open = false,
    glyphClass = "",
    ariaLabel,
    secondaryActionLabel = "Open in side pane",
    "data-testid": dataTestId,
    "data-state": dataState,
    onOpen,
    onOpenSecondary,
    glyph,
    rail,
  }: Props = $props();

  function handleClick(e: MouseEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    if ((e.metaKey || e.ctrlKey) && onOpenSecondary) {
      onOpenSecondary();
      return;
    }
    onOpen();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpen();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tx-row"
  class:is-clickable={!!onOpen}
  class:is-open={open}
  class:ends-in-button={!!onOpenSecondary}
  role={onOpen ? "button" : undefined}
  tabindex={onOpen ? 0 : undefined}
  aria-label={onOpen ? (ariaLabel ?? name) : undefined}
  aria-current={open ? "true" : undefined}
  data-testid={dataTestId}
  data-state={dataState}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <span class="tx-row__glyph {glyphClass}" aria-hidden="true">{@render glyph()}</span>
  <span class="tx-row__name truncate">{name}</span>
  {#if activity}
    <span class="tx-row__activity truncate" class:activity-shimmer={isLive}>{activity}</span>
  {/if}
  {#if target}
    <span class="tx-row__target min-w-0 truncate">{target}</span>
  {/if}
  <span class="flex-1"></span>
  {#if rail}
    <span class="tx-row__rail">{@render rail()}</span>
  {/if}
  {#if onOpenSecondary}
    <button
      type="button"
      class="tx-row__split"
      aria-label={secondaryActionLabel}
      title={secondaryActionLabel}
      onclick={(e) => {
        e.stopPropagation();
        onOpenSecondary();
      }}
    >
      <PanelRightIcon size={12} />
    </button>
  {/if}
</div>

<style>
  .tx-row {
    display: flex;
    min-width: 0;
    height: var(--tx-card-row);
    flex-shrink: 0;
    align-items: center;
    gap: var(--tx-card-gap);
    border-radius: var(--tx-card-row-radius);
    padding: 0 0.5rem;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .tx-row.ends-in-button {
    padding-right: 0.25rem;
  }

  .tx-row.is-clickable {
    cursor: pointer;
  }

  .tx-row.is-clickable:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  .tx-row:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.125rem;
  }

  /* The composer's focus ring, inset: the card clips anything outside the row. */
  .tx-row.is-open {
    box-shadow: inset 0 0 0 0.0625rem color-mix(in oklch, var(--solus-accent) 34%, transparent);
  }

  .tx-row__glyph {
    /* Sizes the shared .activity-spinner. */
    --activity-icon-size: 0.75rem;
    display: inline-flex;
    min-width: var(--tx-card-glyph);
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
  }

  .tx-row__glyph :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
  }

  :global(.tx-row__glyph.is-done) {
    color: color-mix(in oklch, var(--chart-3) 70%, var(--foreground));
  }

  :global(.tx-row__glyph.is-failed) {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
  }

  :global(.tx-row__glyph.is-artifact) {
    color: var(--primary);
  }

  /* The name lets a reader act on the row, so the activity gives way first. */
  .tx-row__name {
    min-width: 0;
    flex-shrink: 0;
    max-width: 60%;
    font-size: var(--text-activity-label);
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .tx-row__activity {
    min-width: 0;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }

  .tx-row__target {
    font-size: var(--text-tool-step);
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .tx-row__rail {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    font-size: var(--text-transcript-meta);
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklch, var(--muted-foreground) 55%, transparent);
  }

  .tx-row__split {
    display: inline-flex;
    width: 1.625rem;
    height: 1.625rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .tx-row__split:hover {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--solus-text-primary);
  }

  .tx-row__split:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.0625rem;
  }
</style>
