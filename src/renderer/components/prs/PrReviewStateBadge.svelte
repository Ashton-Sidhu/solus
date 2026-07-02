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

  const base =
    "inline-flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium leading-none";
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
  <span class="{base} text-(--solus-text-tertiary) bg-(--solus-art-raised)">
    <ChatCircleIcon size={10} weight="fill" />
    Commented
  </span>
{:else if state === "DISMISSED"}
  <span class="{base} text-(--solus-text-tertiary) bg-(--solus-art-raised)">
    <MinusCircleIcon size={10} weight="fill" />
    Dismissed
  </span>
{:else}
  <span class="{base} px-1.5 text-(--solus-text-tertiary) bg-(--solus-art-raised)">
    Pending
  </span>
{/if}
