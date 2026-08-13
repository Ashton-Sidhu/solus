<script lang="ts">
  import { GitCommitIcon } from "phosphor-svelte";
  import type { PrCommit } from "../../../shared/providers";
  import { Button } from "../ui/button";

  // Scope band above the diff while it shows one commit of the pull request.
  // It names the current state and carries the way back to the full diff.
  let {
    commit,
    onClear,
  }: {
    commit: PrCommit;
    onClear: () => void;
  } = $props();
</script>

<div class="flex shrink-0 items-center gap-2.5 border-b border-border bg-card px-3 py-2">
  <GitCommitIcon size={16} weight="duotone" class="shrink-0 text-primary" />
  <div class="min-w-0 flex-1">
    <p class="flex min-w-0 items-baseline gap-2 text-xs font-medium text-foreground">
      <code class="shrink-0 font-mono text-primary">{commit.sha.slice(0, 7)}</code>
      <span class="truncate">{commit.message}</span>
    </p>
    <p class="truncate text-xs text-muted-foreground">
      Changes from this commit only · inline comments apply to the full diff
    </p>
  </div>
  <Button
    variant="ghost"
    size="sm"
    class="h-10 shrink-0 rounded-lg px-3 text-xs"
    onclick={onClear}
  >
    View all changes
  </Button>
</div>
