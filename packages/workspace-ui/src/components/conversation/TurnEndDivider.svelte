<script lang="ts">
  import { ArrowCounterClockwiseIcon, MinusIcon, SquareIcon } from "phosphor-svelte";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import { NO_REPLY_LABEL } from "./lib/transient";
  import type { TurnEnd } from "./lib/turns";

  /**
   * §17's two transient endings — a stop and a turn that answered nothing. Both
   * are events that closed the turn rather than descriptions of the work in it,
   * so they sit *after* the turn's activity row and its answer, where they
   * happened. The row above still summarises and discloses the work, which is
   * what keeps a stopped turn's transcript reachable.
   *
   * A failure is not here: it keeps the row's geometry so it can carry the
   * provider's error verbatim.
   */
  interface Props {
    end: TurnEnd;
    /** Retry re-runs the last prompt, so only the last turn can offer it. */
    onRetry?: () => void;
    skipMotion?: boolean;
  }

  let { end, onRetry, skipMotion = false }: Props = $props();

  // §17 — the same words on whichever surface fired, so there is one retry
  // pattern to learn.
  const RETRY_LABEL = "Retry from your message";
</script>

{#snippet stopGlyph()}<SquareIcon size={9} weight="bold" />{/snippet}

{#snippet noReplyGlyph()}<MinusIcon size={10} weight="bold" />{/snippet}

{#snippet dividerRetry()}
  <button type="button" class="divider-action" onclick={onRetry}>
    <ArrowCounterClockwiseIcon size={10} />{RETRY_LABEL}
  </button>
{/snippet}

<TranscriptDivider
  glyph={end.kind === "no-reply" ? noReplyGlyph : stopGlyph}
  timestamp={end.timestamp}
  action={onRetry ? dividerRetry : undefined}
  testid="turn-end-{end.kind}"
  {skipMotion}
>
  {#if end.kind === "no-reply"}
    {NO_REPLY_LABEL}
  {:else}
    Stopped{end.cause ? ` ${end.cause}` : ""}
  {/if}
</TranscriptDivider>
