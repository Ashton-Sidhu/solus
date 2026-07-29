<script lang="ts">
  import { XIcon, PaperPlaneTiltIcon, CaretUpIcon } from "phosphor-svelte";
  import type { ReviewDraftComment } from "../../../shared/review";
  import { Button } from "../ui/button";

  // The pending-review tray (decision #16: pending drafts live here, not in
  // Activity). A footer over the review surface listing queued comments with
  // remove + jump, and the submit button. The PR review host submits to GitHub;
  // the local review guide host sends the drafts to the agent.
  let {
    drafts,
    submitLabel = "Submit review",
    onSubmit,
    onRemove,
    onJump,
  }: {
    drafts: ReviewDraftComment[];
    submitLabel?: string;
    /** Omit where the host owns the send action (the review guide's composer). */
    onSubmit?: () => void;
    onRemove: (id: string) => void;
    onJump?: (path: string, line: number, side: "old" | "new") => void;
  } = $props();

  let expanded = $state(false);
</script>

<div class="shrink-0 border-t border-border bg-card">
  {#if expanded}
    <ul class="flex max-h-48 flex-col gap-1 overflow-y-auto px-3 pt-2">
      {#each drafts as d (d.id)}
        <li class="flex items-start gap-2 rounded-lg bg-card px-2.5 py-1.5">
          <!-- A list row, not a button primitive: two stacked lines, left-aligned. -->
          <button
            type="button"
            class="min-w-0 flex-1 cursor-pointer text-left"
            onclick={() => onJump?.(d.path, d.line, d.side)}
          >
            <span class="block truncate font-mono text-[11px] text-muted-foreground">{d.path}:{d.line}</span>
            <span class="block truncate text-[12.5px] text-foreground">{d.body}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            class="cursor-pointer text-muted-foreground hover:bg-muted hover:text-(--solus-status-error)"
            aria-label="Remove comment"
            onclick={() => onRemove(d.id)}
          >
            <XIcon size={13} />
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-2 px-3 py-2">
    <Button
      type="button"
      variant="ghost"
      size="xs"
      class="-ml-2 cursor-pointer gap-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted hover:text-foreground"
      onclick={() => (expanded = !expanded)}
    >
      <CaretUpIcon size={13} class={expanded ? "rotate-180 transition-transform" : "transition-transform"} />
      {drafts.length} pending {drafts.length === 1 ? "comment" : "comments"}
    </Button>
    {#if onSubmit}
      <Button
        type="button"
        class="ml-auto inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-colors"
        onclick={onSubmit}
      >
        <PaperPlaneTiltIcon size={14} weight="bold" />
        {submitLabel}
      </Button>
    {/if}
  </div>
</div>
