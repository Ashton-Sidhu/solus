<script lang="ts">
  /** One codebase in the card of rows on Settings → Codebases: its name, then
   *  its folders and the hosts it covers in one muted line. The name is the
   *  row's open button; Delete at the trailing edge asks first, and says that
   *  no file is deleted. */
  import { FolderGit2 as CodebaseIcon, Trash2 as DeleteIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import McpConfirmPopover from "../settings/McpConfirmPopover.svelte";

  interface Props {
    codebaseId: string;
    name: string;
    summary: string;
    onOpen: () => void;
    onDelete: () => Promise<void>;
  }
  let { codebaseId, name, summary, onOpen, onDelete }: Props = $props();

  let isConfirmingDelete = $state(false);
  let isDeleting = $state(false);
  let deleteError = $state("");
  let deleteButtonEl = $state<HTMLElement | null>(null);

  async function remove() {
    if (isDeleting) return;
    isDeleting = true;
    deleteError = "";
    try {
      await onDelete();
      isConfirmingDelete = false;
    } catch (error) {
      deleteError = error instanceof Error ? error.message : "Could not delete the codebase.";
    } finally {
      isDeleting = false;
    }
  }
</script>

<div class="group relative flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[var(--wash-1)] has-[button[data-open]:focus-visible]:bg-[var(--wash-1)]">
  <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-3)] text-muted-foreground">
    <CodebaseIcon size={14} aria-hidden="true" />
  </span>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <!-- The name is the row's open button; its hit area covers the row. -->
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
  <!-- Above the open button's hit area, so a click here does not open the codebase. -->
  <Button
    bind:ref={deleteButtonEl}
    size="icon-sm"
    variant="ghost"
    class="relative z-[1] shrink-0 text-muted-foreground hover:text-destructive"
    title="Delete codebase"
    aria-label="Delete {name}"
    onclick={() => {
      deleteError = "";
      isConfirmingDelete = true;
    }}
  >
    <DeleteIcon size={16} />
  </Button>
  <McpConfirmPopover
    bind:open={isConfirmingDelete}
    anchor={deleteButtonEl}
    title="Delete {name}?"
    text="The codebase is deleted on each host. Its folders and their files stay where they are: no file is deleted."
    action="Delete"
    busyAction="Deleting…"
    isBusy={isDeleting}
    error={deleteError}
    onConfirm={() => void remove()}
  />
</div>
