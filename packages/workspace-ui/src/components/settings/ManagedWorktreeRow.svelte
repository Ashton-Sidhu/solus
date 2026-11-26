<script lang="ts">
  /** One worktree or task folder that Solus made: the title of its session,
   *  its state in words, when it was used last, and its size. Delete asks
   *  first and names what is lost. One that a session works in offers
   *  "Open session" in place of Delete. */
  import { Trash2 as TrashIcon } from "@lucide/svelte";
  import { managedWorktreeState, type ManagedWorktree } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import McpConfirmPopover from "./McpConfirmPopover.svelte";
  import { deleteConfirmText, formatSize, lastUsedText, worktreeStatusText } from "./lib/managed-worktrees";

  interface Props {
    worktree: ManagedWorktree;
    /** Bytes on disk. Undefined while the host measures it; null when it could not. */
    bytes: number | null | undefined;
    isRemoving: boolean;
    /** Null when the worktree is gone, else why it stays. */
    onRemove: () => Promise<string | null>;
    onOpenSession: (sessionId: string) => void;
  }
  let { worktree, bytes, isRemoving, onRemove, onOpenSession }: Props = $props();

  let isConfirming = $state(false);
  let removeError = $state("");
  let deleteButtonEl = $state<HTMLElement | null>(null);

  const worktreeState = $derived(managedWorktreeState(worktree));
  const lastUsed = $derived(lastUsedText(worktree));

  async function remove() {
    removeError = (await onRemove()) ?? "";
  }
</script>

<div class="flex items-center gap-3 py-2.5 pr-3 pl-4">
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <h4 class="truncate text-sm text-foreground" title={worktree.branch ?? worktree.path}>{worktree.title}</h4>
    <p class="truncate text-chrome-dense text-muted-foreground">
      <span class={worktreeState === "unsaved" ? "text-warning" : worktreeState === "in_use" ? "text-foreground" : ""}>{worktreeStatusText(worktree)}</span>{#if lastUsed}&nbsp;· {lastUsed}{/if}
    </p>
  </div>
  <span class="w-16 shrink-0 text-right text-chrome-dense text-muted-foreground tabular-nums @max-[30rem]/pane:hidden">
    {bytes !== undefined && bytes !== null ? formatSize(bytes) : ""}
  </span>
  <div class="flex w-28 shrink-0 justify-end">
    {#if worktreeState === "in_use"}
      <Button variant="outline" size="sm" class="text-workspace-chrome" onclick={() => onOpenSession(worktree.sessions[0].sessionId)}>
        Open session
      </Button>
    {:else}
      <Button
        bind:ref={deleteButtonEl}
        size="icon-sm"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive pointer-coarse:tap-area"
        disabled={isRemoving}
        title="Delete"
        aria-label="Delete {worktree.title}"
        onclick={() => {
          removeError = "";
          isConfirming = true;
        }}
      >
        <TrashIcon size={16} />
      </Button>
      <McpConfirmPopover
        bind:open={isConfirming}
        anchor={deleteButtonEl}
        title="Delete “{worktree.title}”?"
        text={deleteConfirmText(worktree, bytes)}
        action={worktreeState === "unsaved" ? "Delete and lose work" : "Delete"}
        busyAction="Deleting…"
        isBusy={isRemoving}
        error={removeError}
        onConfirm={() => void remove()}
      />
    {/if}
  </div>
</div>
