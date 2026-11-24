<script lang="ts">
  /** One folder of a codebase: its name and what it is on one line, its path
   *  below, the repositories its host found inside it, and the folders that a
   *  workspace file in it lists. Remove asks first, and says that no file is
   *  deleted. */
  import { Folder as FolderIcon, FolderGit2 as RepositoryFolderIcon, FolderX as MissingFolderIcon, Plus as PlusIcon, X as XIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import McpConfirmPopover from "../settings/McpConfirmPopover.svelte";
  import CodebaseMemberList from "./CodebaseMemberList.svelte";
  import type { CodebaseRootMembers } from "../../contexts/codebases/codebases.store.svelte";
  import { rootDescription, rootName } from "./lib/codebase-view";

  interface Props {
    entry: CodebaseRootMembers;
    /** The host can get a folder now. */
    canAdd: boolean;
    isBusy: boolean;
    onRemove: () => Promise<void>;
    onAddSuggestion: (path: string) => void;
  }
  let { entry, canAdd, isBusy, onRemove, onAddSuggestion }: Props = $props();

  let isConfirmingRemove = $state(false);
  let isRemoving = $state(false);
  let removeError = $state("");
  let removeButtonEl = $state<HTMLElement | null>(null);

  /** The state of the folder itself. Null until its host answers. */
  const folderState = $derived(entry.member?.state ?? null);
  const Icon = $derived(folderState === "git" ? RepositoryFolderIcon : folderState === "missing" ? MissingFolderIcon : FolderIcon);
  const name = $derived(rootName(entry.root));

  async function remove() {
    if (isRemoving) return;
    isRemoving = true;
    removeError = "";
    try {
      await onRemove();
    } catch (error) {
      removeError = error instanceof Error ? error.message : "Could not remove the folder.";
    } finally {
      isRemoving = false;
    }
  }
</script>

<div class="flex flex-col gap-2.5 px-4 py-3">
  <div class="flex items-center gap-3">
    <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-3)] {folderState === 'missing' ? 'text-destructive' : 'text-muted-foreground'}">
      <Icon size={16} aria-hidden="true" />
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex min-w-0 items-baseline gap-2">
        <h4 class="min-w-0 shrink truncate text-workspace-chrome font-medium text-foreground">{name}</h4>
        {#if folderState}
          <span class="shrink-0 text-chrome-dense {folderState === 'missing' ? 'text-destructive' : 'text-muted-foreground'}">
            {rootDescription(folderState, entry.found.length)}
          </span>
        {/if}
      </div>
      <p class="truncate font-mono text-xs text-muted-foreground" title={entry.root.path}>{entry.root.path}</p>
    </div>
    <Button
      bind:ref={removeButtonEl}
      size="icon-sm"
      variant="ghost"
      class="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={isBusy}
      title="Remove from the codebase"
      aria-label="Remove {name} from the codebase"
      onclick={() => {
        removeError = "";
        isConfirmingRemove = true;
      }}
    >
      <XIcon size={16} />
    </Button>
    <McpConfirmPopover
      bind:open={isConfirmingRemove}
      anchor={removeButtonEl}
      title="Remove {name}?"
      text="The folder is removed from the codebase. No file is deleted."
      action="Remove"
      busyAction="Removing…"
      isBusy={isRemoving}
      error={removeError}
      onConfirm={() => void remove()}
    />
  </div>

  {#if folderState === "missing"}
    <p class="pl-11 text-[13px] leading-[1.45] text-(--solus-text-secondary)">
      This folder does not exist on the host now. It stays in the codebase until you remove it.
    </p>
  {:else if entry.found.length > 0}
    <div class="pl-11">
      <CodebaseMemberList members={entry.found} label="Repositories found in {name}" />
    </div>
  {/if}

  {#if entry.suggestions.length > 0}
    <div class="flex flex-col gap-1.5 pl-11">
      <p class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">A workspace file in this folder also lists:</p>
      <ul class="flex flex-col gap-1" aria-label="Folders that a workspace file in {entry.root.name} lists">
        {#each entry.suggestions as suggestion (suggestion.path)}
          <li class="flex min-w-0 items-center gap-2 text-[13px]">
            <span class="max-w-[40%] shrink-0 truncate font-medium text-foreground">{suggestion.name}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={suggestion.path}>{suggestion.path}</span>
            <Button
              size="xs"
              variant="outline"
              class="shrink-0"
              disabled={isBusy || !canAdd}
              aria-label="Add {suggestion.name} to the codebase"
              onclick={() => onAddSuggestion(suggestion.path)}
            >
              <PlusIcon size={12} /> Add
            </Button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
