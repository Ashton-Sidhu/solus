<script lang="ts">
  import {
    CircleCheck as CheckCircleIcon,
    RefreshCcw as ArrowsCounterClockwiseIcon,
    MessageCircle as ChatCircleIcon,
    CircleMinus as MinusCircleIcon,
  } from "@lucide/svelte";
  import type { PrReviewer } from "@solus/contracts/providers";

  // A reviewer's standing state, shared by the PRs page rail and the PR review
  // activity feed. `null` = requested but hasn't reviewed yet; PENDING never
  // reaches the renderer (the provider skips unsubmitted drafts).
  let { state }: { state: PrReviewer["state"] } = $props();

  // Approval and a change request are the only two states that carry colour;
  // everything else is a muted note, so the badge is one shape with one word
  // and one optional tone.
  const tone = $derived(
    state === "APPROVED"
      ? "text-(--solus-art-positive) bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)]"
      : state === "CHANGES_REQUESTED"
        ? "text-(--solus-art-negative) bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)]"
        : "text-muted-foreground bg-muted",
  );
</script>

<!-- shrink-0 + nowrap: in the rail's reviewer row the badge sits next to a
     flexible login, and a shrinkable badge collapses its own label instead of
     letting the login truncate. -->
<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-normal whitespace-nowrap {tone}"
>
  {#if state === "APPROVED"}
    <CheckCircleIcon size={10} weight="fill" />
    Approved
  {:else if state === "CHANGES_REQUESTED"}
    <ArrowsCounterClockwiseIcon size={10} weight="bold" />
    Changes
  {:else if state === "COMMENTED"}
    <ChatCircleIcon size={10} weight="fill" />
    Commented
  {:else if state === "DISMISSED"}
    <MinusCircleIcon size={10} weight="fill" />
    Dismissed
  {:else}
    Pending
  {/if}
</span>
