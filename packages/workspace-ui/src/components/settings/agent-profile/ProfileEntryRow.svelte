<script lang="ts">
  /**
   * One entry of the agent profile, drawn like a server on the MCP page: a
   * 32-pixel mark, the name over one quiet line of detail, then the row's
   * action. The mark is the server's logo or a tile with the entry's icon.
   */
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    detail: string;
    /** Read in a monospace face: a file path, not a name. */
    isPath?: boolean;
    mark: Snippet;
    action: Snippet;
    testId?: string;
  }

  let { label, detail, isPath = false, mark, action, testId }: Props = $props();
</script>

<div class="flex min-w-0 items-center gap-3 px-4 py-3" data-testid={testId}>
  {@render mark()}
  <div class="flex min-w-0 flex-1 flex-col">
    <span class="truncate text-workspace-chrome font-medium text-foreground {isPath ? 'font-mono' : ''}" title={label}>{label}</span>
    <span class="truncate text-chrome-dense text-(--solus-text-tertiary)" title={detail}>{detail}</span>
  </div>
  <div class="flex shrink-0 items-center gap-2">{@render action()}</div>
</div>
