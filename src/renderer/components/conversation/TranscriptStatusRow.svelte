<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A condition the thread can't fix — it belongs to the host, not to a turn:
   * the machine's reachability. Anything that holds a prompt is a card.
   *
   * One line, one glyph, one remedy. Written as a condition, not an apology.
   */
  interface Props {
    /** The only tinted pixel on the row. */
    tone?: "warning" | "destructive" | "neutral";
    /** 0–1, or null for an indeterminate crawl. Omit for no track at all. */
    progress?: number | null;
    /** Right of the rail, e.g. "resets 5:41 PM". */
    clearsAt?: string;
    "data-testid"?: string;
    glyph: Snippet;
    children: Snippet;
    actions?: Snippet;
  }

  let {
    tone = "warning",
    progress,
    clearsAt,
    "data-testid": dataTestId,
    glyph,
    children,
    actions,
  }: Props = $props();

  const TONE: Record<NonNullable<Props["tone"]>, string> = {
    warning: "color-mix(in oklch, var(--chart-2) 68%, var(--foreground))",
    destructive: "var(--destructive)",
    neutral: "var(--muted-foreground)",
  };
  const hasTrack = $derived(progress !== undefined);
</script>

<div
  class="status-row flex items-center gap-2.5 rounded-xl py-[0.4375rem] pr-3 pl-2.5"
  role="status"
  data-testid={dataTestId}
>
  <span class="status-row-glyph" style="color:{TONE[tone]}">{@render glyph()}</span>

  <span class="status-row-text min-w-0 shrink truncate">{@render children()}</span>

  {#if hasTrack}
    <span class="status-row-track shrink-0" class:is-indeterminate={progress === null}>
      <span
        class="status-row-fill"
        style={progress === null
          ? ""
          : `width:${Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100)}%;background:${TONE[tone]}`}
      ></span>
    </span>
  {/if}

  <span class="flex-1"></span>

  {#if clearsAt}
    <span class="status-row-clears font-mono shrink-0">{clearsAt}</span>
  {/if}
  {#if actions}
    {@render actions()}
  {/if}
</div>

<style>
  /* The remedy buttons live in the caller's `actions` snippet, so the row can
     only reach them globally. */
  :global(.status-row-action) {
    flex-shrink: 0;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0.1875rem 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.71875rem;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  :global(.status-row-action):hover {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--solus-text-primary);
  }

  .status-row {
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 7%, transparent);
  }

  .status-row-glyph {
    display: inline-flex;
    width: 1.375rem;
    height: 1.125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }

  .status-row-text {
    font-size: 0.78125rem;
    color: var(--solus-text-primary);
    white-space: nowrap;
  }

  .status-row-track {
    position: relative;
    display: block;
    width: 4.5rem;
    height: 0.1875rem;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
  }

  .status-row-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
  }

  .status-row-track.is-indeterminate .status-row-fill {
    width: 35%;
    background: currentColor;
    animation: status-row-crawl 1.6s ease-in-out infinite;
  }

  .status-row-clears {
    font-size: 0.65625rem;
    color: var(--muted-foreground);
    opacity: 0.55;
  }

  @keyframes status-row-crawl {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(320%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-row-track.is-indeterminate .status-row-fill {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }
</style>
