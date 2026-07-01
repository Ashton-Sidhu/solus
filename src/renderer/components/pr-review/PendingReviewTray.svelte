<script lang="ts">
  import { XIcon, PaperPlaneTiltIcon, CaretUpIcon } from "phosphor-svelte";
  import type { ReviewDraftComment } from "../../../shared/review";

  // The pending-review tray (decision #16: pending drafts live here, not in
  // Activity). A footer over the review surface listing queued GitHub-bound
  // comments with remove + jump, and the Submit button that opens the modal.
  let {
    drafts,
    onSubmit,
    onRemove,
    onJump,
  }: {
    drafts: ReviewDraftComment[];
    onSubmit: () => void;
    onRemove: (id: string) => void;
    onJump?: (path: string, line: number) => void;
  } = $props();

  let expanded = $state(false);
</script>

<div class="shrink-0 border-t border-(--solus-art-border) bg-(--solus-container-bg)">
  {#if expanded}
    <ul class="flex max-h-48 flex-col gap-1 overflow-y-auto px-3 pt-2">
      {#each drafts as d (d.id)}
        <li class="flex items-start gap-2 rounded-lg bg-(--solus-art-surface) px-2.5 py-1.5">
          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            onclick={() => onJump?.(d.path, d.line)}
          >
            <span class="block truncate font-mono text-[0.6875rem] text-(--solus-text-tertiary)">{d.path}:{d.line}</span>
            <span class="block truncate text-[0.8125rem] text-(--solus-text-secondary)">{d.body}</span>
          </button>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-accent-light) hover:text-(--solus-status-error)"
            aria-label="Remove comment"
            onclick={() => onRemove(d.id)}
          >
            <XIcon size={13} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-2 px-3 py-2">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-(--solus-text-secondary) hover:text-(--solus-text-primary)"
      onclick={() => (expanded = !expanded)}
    >
      <CaretUpIcon size={13} class={expanded ? "rotate-180 transition-transform" : "transition-transform"} />
      {drafts.length} pending {drafts.length === 1 ? "comment" : "comments"}
    </button>
    <button
      type="button"
      class="ml-auto inline-flex items-center gap-1.5 rounded-md bg-(--solus-accent) px-3 py-1.5 text-[0.8125rem] font-semibold text-(--solus-on-accent,#fff) transition-opacity hover:opacity-90"
      onclick={onSubmit}
    >
      <PaperPlaneTiltIcon size={14} weight="bold" />
      Submit review
    </button>
  </div>
</div>
