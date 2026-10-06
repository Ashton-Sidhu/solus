<script lang="ts">
  import {
    CircleAlert as CircleAlertIcon,
    CircleCheck as CheckCircleIcon,
    CircleMinus as MinusCircleIcon,
    Clock as ClockIcon,
    MessageCircle as MessageCircleIcon,
  } from "@lucide/svelte";
  import type { PrReviewer } from "@solus/contracts/providers";
  import { reviewerStateColor } from "./lib/reviewer-state";

  /** A reviewer's verdict as one glyph in its own colour. The rail's rows and
   *  the narrow pane's avatar badges share it, so a verdict looks the same in
   *  both. The word stays on the caller's title and accessible name. */
  let { state, size = 14 }: { state: PrReviewer["state"]; size?: number } = $props();
</script>

<span class="contents" style={`color:${reviewerStateColor(state)}`}>
  {#if state === "APPROVED"}
    <CheckCircleIcon {size} aria-hidden="true" />
  {:else if state === "CHANGES_REQUESTED"}
    <CircleAlertIcon {size} aria-hidden="true" />
  {:else if state === "COMMENTED"}
    <MessageCircleIcon {size} aria-hidden="true" />
  {:else if state === "DISMISSED"}
    <MinusCircleIcon {size} aria-hidden="true" />
  {:else}
    <ClockIcon {size} aria-hidden="true" />
  {/if}
</span>
