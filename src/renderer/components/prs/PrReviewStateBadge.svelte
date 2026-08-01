<script lang="ts">
  import {
    CheckCircleIcon,
    ArrowsCounterClockwiseIcon,
    ChatCircleIcon,
    MinusCircleIcon,
  } from "phosphor-svelte";
  import type { PrReviewer } from "../../../shared/providers";

  // A reviewer's standing state, shared by the PRs page rail and the PR review
  // activity feed. `null` = requested but hasn't reviewed yet; PENDING never
  // reaches the renderer (the provider skips unsubmitted drafts).
  let { state }: { state: PrReviewer["state"] } = $props();

  // shrink-0 + nowrap: in the rail's reviewer row the badge sits next to a
  // flexible login, and a shrinkable badge collapses its own label instead of
  // letting the login truncate.
  const base =
    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap";
</script>

{#if state === "APPROVED"}
  <span class="{base} text-(--solus-art-positive) bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)]">
    <CheckCircleIcon size={10} weight="fill" />
    Approved
  </span>
{:else if state === "CHANGES_REQUESTED"}
  <span class="{base} text-(--solus-art-negative) bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)]">
    <ArrowsCounterClockwiseIcon size={10} weight="bold" />
    Changes
  </span>
{:else if state === "COMMENTED"}
  <span class="{base} text-muted-foreground bg-muted">
    <ChatCircleIcon size={10} weight="fill" />
    Commented
  </span>
{:else if state === "DISMISSED"}
  <span class="{base} text-muted-foreground bg-muted">
    <MinusCircleIcon size={10} weight="fill" />
    Dismissed
  </span>
{:else}
  <span class="{base} text-muted-foreground bg-muted">
    Pending
  </span>
{/if}
