<script lang="ts">
  import { Button } from "../ui/button";

  let {
    parent,
    fileCount,
    showingFull,
    onToggle,
  }: {
    parent: number;
    fileCount: number | null;
    showingFull: boolean;
    onToggle: () => void;
  } = $props();
</script>

<div
  class="flex min-h-10 shrink-0 items-center gap-2 border-b border-(--solus-accent-border) bg-secondary px-3 text-[12px] text-foreground"
  role="status"
>
  {#if showingFull}
    <strong class="truncate font-medium text-foreground">
      Viewing the full diff against the target branch
    </strong>
    <span aria-hidden="true" class="text-muted-foreground">·</span>
    <Button
      type="button"
      variant="link"
      class="h-auto min-h-10 p-0 text-[12px] font-medium text-primary underline decoration-(--solus-accent-border) underline-offset-2 hover:text-foreground focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      onclick={onToggle}
    >
      Back to own changes
    </Button>
  {:else}
    <strong class="truncate font-medium text-foreground">
      Showing this PR's own changes on top of #{parent}
    </strong>
    <span aria-hidden="true" class="text-muted-foreground">·</span>
    <em class="shrink-0 tabular-nums text-foreground">
      {fileCount === null ? "… files" : `${fileCount} ${fileCount === 1 ? "file" : "files"}`}
    </em>
    <span aria-hidden="true" class="text-muted-foreground">—</span>
    <Button
      type="button"
      variant="link"
      class="h-auto min-h-10 p-0 text-[12px] font-medium text-primary underline decoration-(--solus-accent-border) underline-offset-2 hover:text-foreground focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      onclick={onToggle}
    >
      View full diff vs main
    </Button>
  {/if}
</div>
