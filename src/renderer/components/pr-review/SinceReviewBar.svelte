<script lang="ts">
  import { CaretDownIcon, ClockCounterClockwiseIcon, WarningCircleIcon } from "phosphor-svelte";
  import type { PrInterdiffResult } from "../../../shared/types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { reviewCommentPreview, reviewedAtLabel, unmatchedReviewComments } from "./lib/since-review";

  let {
    result,
    showingSince,
    onModeChange,
  }: {
    result: PrInterdiffResult;
    showingSince: boolean;
    onModeChange: (sinceReview: boolean) => void;
  } = $props();

  const unmatched = $derived(unmatchedReviewComments(result));
  const isInvalid = $derived(result.state === "invalid");
</script>

<div class="shrink-0 border-b border-(--solus-container-border) bg-(--solus-container-bg) px-3 py-2">
  <div class="flex min-w-0 items-center gap-2.5">
    {#if isInvalid}
      <WarningCircleIcon size={16} weight="fill" class="shrink-0 text-(--solus-status-permission)" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold text-(--solus-text-primary)">Review checkpoint no longer applies</p>
        <p class="truncate text-[0.6875rem] text-(--solus-text-tertiary)">
          {result.invalidReason === "base-changed"
            ? "The PR base changed, so the full diff is shown."
            : "The reviewed commit is no longer available, so the full diff is shown."}
        </p>
      </div>
    {:else}
      <ClockCounterClockwiseIcon size={16} weight="duotone" class="shrink-0 text-(--solus-accent)" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold text-(--solus-text-primary)">Since your review</p>
        <p class="truncate text-[0.6875rem] text-(--solus-text-tertiary)">
          Compared with {reviewedAtLabel(result.checkpoint?.reviewedAt ?? "")}
        </p>
      </div>
      <div class="flex shrink-0 rounded-xl bg-(--solus-accent-light) p-1" role="group" aria-label="Diff range">
        <Button
          variant="ghost"
          size="sm"
          class={`h-10 rounded-lg px-3 text-xs active:scale-[0.96] ${showingSince ? "bg-(--solus-container-bg) text-(--solus-text-primary) shadow-sm" : "text-(--solus-text-tertiary)"}`}
          aria-pressed={showingSince}
          onclick={() => onModeChange(true)}
        >
          Since review
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class={`h-10 rounded-lg px-3 text-xs active:scale-[0.96] ${!showingSince ? "bg-(--solus-container-bg) text-(--solus-text-primary) shadow-sm" : "text-(--solus-text-tertiary)"}`}
          aria-pressed={!showingSince}
          onclick={() => onModeChange(false)}
        >
          Full diff
        </Button>
      </div>
    {/if}
  </div>

  {#if showingSince && unmatched.length > 0}
    <details class="mt-1.5 text-[0.6875rem] text-(--solus-text-tertiary)">
      <summary
        class="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 tabular-nums hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)"
        onclick={requestInputFocus}
      >
        <CaretDownIcon size={11} weight="bold" class="details-chevron transition-transform" />
        {unmatched.length} comment{unmatched.length === 1 ? "" : "s"} not obviously addressed
      </summary>
      <ul class="ml-5 space-y-1 pb-1">
        {#each unmatched as match (match.thread.id)}
          <li class="flex min-w-0 gap-1.5">
            <span class="shrink-0 font-medium text-(--solus-text-secondary)">{match.thread.filePath}:{match.thread.line ?? "outdated"}</span>
            <span class="truncate">{reviewCommentPreview(match.thread, 120)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  details[open] .details-chevron {
    transform: rotate(180deg);
  }
</style>
