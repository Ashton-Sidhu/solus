<script lang="ts">
  /** One folder of a codebase: its name, path, and state, the repositories its
   *  host found inside it, and the folders that a workspace file in it lists.
   *  Remove asks first, and says that no file is deleted. */
  import { Folder as FolderIcon, FolderGit2 as RepositoryFolderIcon, FolderX as MissingFolderIcon, Plus as PlusIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { ListChip } from "../ui/list-page";
  import McpConfirmPopover from "../settings/McpConfirmPopover.svelte";
  import CodebaseMemberList from "./CodebaseMemberList.svelte";
  import type { CodebaseRootMembers } from "../../contexts/codebases/codebases.store.svelte";
  import { memberStateLabel, memberStateTint } from "./lib/codebase-view";

  interface Props {
    entry: CodebaseRootMembers;
    /** The host can get a folder now. */
    canAdd: boolean;
    isBusy: boolean;
    /** False when the codebase has only two folders left: the page says to delete the codebase. */
    canRemove: boolean;
    onRemove: () => Promise<void>;
    onAddSuggestion: (path: string) => void;
  }
  let { entry, canAdd, isBusy, canRemove, onRemove, onAddSuggestion }: Props = $props();

  let isConfirmingRemove = $state(false);
  let isRemoving = $state(false);
  let removeError = $state("");
  let removeButtonEl = $state<HTMLElement | null>(null);

  /** The state of the folder itself. Null until its host answers. */
  const folderState = $derived(entry.member?.state ?? null);
  const Icon = $derived(folderState === "git" ? RepositoryFolderIcon : folderState === "missing" ? MissingFolderIcon : FolderIcon);

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

<div class="flex flex-col gap-3 px-4 py-3.5">
  <div class="flex items-start gap-3">
    <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-3)] text-muted-foreground">
      <Icon size={14} aria-hidden="true" />
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex min-w-0 items-center gap-2">
        <h4 class="min-w-0 truncate text-sm font-medium tracking-[-0.005em] text-foreground">{entry.root.name}</h4>
        {#if folderState}
          <ListChip chip={{ label: memberStateLabel(folderState), tint: memberStateTint(folderState) }} />
        {/if}
      </div>
      <p class="truncate font-mono text-xs text-muted-foreground" title={entry.root.path}>{entry.root.path}</p>
    </div>
    <Button
      bind:ref={removeButtonEl}
      size="sm"
      variant="ghost"
      class="shrink-0"
      disabled={isBusy || !canRemove}
      aria-describedby={canRemove ? undefined : "codebase-removal-refusal"}
      aria-label="Remove {entry.root.name} from the codebase"
      onclick={() => {
        removeError = "";
        isConfirmingRemove = true;
      }}
    >
      Remove
    </Button>
    <McpConfirmPopover
      bind:open={isConfirmingRemove}
      anchor={removeButtonEl}
      title="Remove {entry.root.name}?"
      text="The folder is removed from the codebase. No file is deleted."
      action="Remove"
      busyAction="Removing…"
      isBusy={isRemoving}
      error={removeError}
      onConfirm={() => void remove()}
    />
  </div>

  {#if folderState === "missing"}
    <p class="pl-10 text-[13px] leading-[1.45] text-(--solus-text-secondary)">
      This folder does not exist on the host now. It stays in the codebase until you remove it.
    </p>
  {:else if entry.found.length > 0}
    <div class="pl-10">
      <CodebaseMemberList members={entry.found} label="Repositories found in {entry.root.name}" />
    </div>
  {:else if entry.member}
    <p class="pl-10 text-[13px] leading-[1.45] text-(--solus-text-secondary)">No repository was found inside this folder.</p>
  {/if}

  {#if entry.suggestions.length > 0}
    <div class="flex flex-col gap-1.5 pl-10">
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
