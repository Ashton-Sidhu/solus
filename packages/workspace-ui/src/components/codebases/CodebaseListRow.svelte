<script lang="ts">
  /** One codebase in the card of rows on Settings → Codebases: its name, then
   *  its folders and the hosts it covers in one muted line. The name is the
   *  row's one button. */
  import { FolderGit2 as CodebaseIcon } from "@lucide/svelte";

  let { codebaseId, name, summary, onOpen }: { codebaseId: string; name: string; summary: string; onOpen: () => void } = $props();
</script>

<div class="group relative flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[var(--wash-1)] has-[button[data-open]:focus-visible]:bg-[var(--wash-1)]">
  <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-3)] text-muted-foreground">
    <CodebaseIcon size={14} aria-hidden="true" />
  </span>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <!-- The name is the row's one button; its hit area covers the row. -->
    <button
      type="button"
      data-open
      data-codebase-row={codebaseId}
      class="min-w-0 cursor-pointer truncate text-left text-workspace-chrome font-medium text-foreground outline-none after:absolute after:inset-0 after:content-['']"
      onclick={onOpen}
    >
      {name}
    </button>
    <p class="truncate text-chrome-dense text-muted-foreground" title={summary}>{summary}</p>
  </div>
</div>
