<script lang="ts">
  import { Copy as CopyIcon, Check as CheckIcon } from "@lucide/svelte";
  import { runtime } from "../../contexts";
  import { formatRailTime, formatRailTitle } from "./lib/hover-rail";
  import { messageTimestampClock } from "../../lib/shared-clock";

  /**
   * The rail every message hangs on its outer edge — left of assistant prose,
   * right of a user bubble. It holds exactly two things, stacked: the
   * timestamp, then a copy control. A third affordance is a design error;
   * anything else belongs to the card's own menu.
   *
   * The assistant copy control aligns with the first line of prose. The user
   * rail remains bottom-aligned with its bubble.
   */
  interface Props {
    timestamp?: number;
    /** Markdown source, not rendered text — fenced blocks and lists survive. */
    text: string;
    /** Which edge to hang from: assistant prose left, user bubble right. */
    side?: "left" | "right";
  }
  let { timestamp, text, side = "left" }: Props = $props();

  let copied = $state(false);
  let now = $state(Date.now());

  // Hundreds of historical rows share one visibility-aware minute ticker.
  $effect(() => {
    if (!timestamp) return;
    return messageTimestampClock.subscribe((value) => { now = value; });
  });

  const label = $derived(
    timestamp ? formatRailTime(timestamp, now) : "",
  );
  const title = $derived(timestamp ? formatRailTitle(timestamp) : "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {}
  }
</script>

<div
  class="hover-rail flex flex-col {side === 'right' ? 'items-start' : 'items-end'}"
  class:is-right={side === "right"}
  class:is-first-line={side === "left"}
  class:is-touch={runtime.isTouchDevice}
>
  {#if label}
    <span class="hover-rail-time text-conversation-gutter" {title}>{label}</span>
  {/if}
  {#if text}
    <button
      type="button"
      class="hover-rail-copy"
      class:is-copied={copied}
      onclick={copy}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {#if copied}
        <CheckIcon size={11} weight="bold" />
      {:else}
        <CopyIcon size={12} />
      {/if}
    </button>
  {/if}
</div>

<style>
  .hover-rail {
    position: absolute;
    right: 100%;
    bottom: 0.375rem;
    margin-right: 0.625rem;
    gap: 0.25rem;
    opacity: 0;
    /* Hide is slower than reveal, and lags slightly so the rail survives the
       pointer crossing from the text into the margin. */
    transition: opacity 120ms ease-out 40ms;
  }

  .hover-rail.is-right {
    right: auto;
    left: 100%;
    margin-right: 0;
    margin-left: 0.625rem;
  }

  /* The assistant row has 0.5rem top padding and 1.75rem line-height. Center
     the 1.375rem copy control on that first line. Keep the timestamp above the
     control without letting it shift the control down. */
  .hover-rail.is-first-line {
    top: 0.6875rem;
    bottom: auto;
    gap: 0;
  }

  .hover-rail.is-first-line .hover-rail-time {
    position: absolute;
    right: 0;
    bottom: calc(100% + 0.25rem);
  }

  /* The hover target is the whole message row — the pointer never has to find a
     22px square. */
  :global(.cv-rail-host:hover) .hover-rail,
  :global(.cv-rail-host:focus-within) .hover-rail {
    opacity: 1;
    transition: opacity 90ms ease-out;
  }

  /* There is no hover to reveal it, so it simply stays. */
  .hover-rail.is-touch {
    opacity: 0.45;
  }

  .hover-rail-time {
    color: var(--muted-foreground);
    opacity: 0.55;
    white-space: nowrap;
    user-select: none;
  }

  .hover-rail-copy {
    display: inline-flex;
    width: 1.375rem;
    height: 1.375rem;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted-foreground);
    opacity: 0.6;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  /* The wash lands on the button only, never the row. */
  .hover-rail-copy:hover {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    opacity: 1;
  }
  .hover-rail-copy:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.0625rem;
    opacity: 1;
  }
  /* The one place a tool state is confirmed with a hue — for 1.2s, at 22px. */
  .hover-rail-copy.is-copied {
    background: color-mix(in oklch, var(--chart-3) 14%, transparent);
    color: color-mix(in oklch, var(--chart-3) 62%, var(--foreground));
    opacity: 1;
  }
</style>
