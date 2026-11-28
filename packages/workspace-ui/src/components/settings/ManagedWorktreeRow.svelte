<script lang="ts">
  /** One worktree or task folder that Solus made: the title of its session,
   *  its state in words, when it was used last, and its size. Two actions sit
   *  in the same place on every row: open its session, and delete it. Delete
   *  asks first and names what is lost; it waits while a turn runs there.
   *  While a removal runs, the row says that it is being deleted or waits. */
  import { ArrowUpRight as OpenIcon, LoaderCircle, Trash2 as TrashIcon } from "@lucide/svelte";
  import { formatResourceBytes } from "@solus/client-core/host-resource-watch";
  import { deleteConfirmText, idleSessions, worktreeStatusText } from "@solus/client-core/managed-worktrees";
  import { managedWorktreeState, type ManagedWorktree } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import { ListSelectCheckbox, type ListSelection } from "../ui/list-page";
  import { Skeleton } from "../ui/skeleton";
  import McpConfirmPopover from "./McpConfirmPopover.svelte";
  import { lastUsedText } from "./lib/managed-worktrees";

  interface Props {
    worktree: ManagedWorktree;
    /** Bytes on disk. Undefined while the host measures it; null when it could not. */
    bytes: number | null | undefined;
    isRemoving: boolean;
    /** Its place in the running removal: deleted now, waiting, or not in it. */
    removal: "deleting" | "waiting" | null;
    selection: ListSelection;
    /** Null when the worktree is gone, else why it stays. */
    onRemove: () => Promise<string | null>;
    onOpenSession: (sessionId: string) => void;
  }
  let { worktree, bytes, isRemoving, removal, selection, onRemove, onOpenSession }: Props = $props();

  let isConfirming = $state(false);
  let removeError = $state("");
  let deleteButtonEl = $state<HTMLElement | null>(null);

  const worktreeState = $derived(managedWorktreeState(worktree));
  const isSelected = $derived(selection.has(worktree.path));
  const lastUsed = $derived(lastUsedText(worktree));
  const isSessionOpen = $derived(idleSessions(worktree).length > 0);
  const openSessionId = $derived(worktree.sessions[0]?.sessionId ?? worktree.sessionId);

  async function remove() {
    removeError = (await onRemove()) ?? "";
  }
</script>

<div
  class="group flex min-h-15 items-center gap-3 py-2.5 pr-2.5 pl-4 transition-colors duration-150 {isSelected
    ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,var(--background))]'
    : ''}"
  data-selected={isSelected}
  aria-busy={removal === "deleting"}
  data-selectable-worktree={worktreeState === "in_use" ? undefined : worktree.path}
>
  {#if worktreeState === "in_use"}
    <span class="size-4 shrink-0" aria-hidden="true"></span>
  {:else}
    <ListSelectCheckbox {selection} id={worktree.path} noun={worktree.title} disabled={isRemoving} />
  {/if}
  <div class="flex min-w-0 flex-1 flex-col gap-1">
    <h4 class="truncate text-sm font-medium tracking-[-0.005em] text-foreground" title={worktree.branch ?? worktree.path}>{worktree.title}</h4>
    <p class="flex min-w-0 items-baseline gap-1.5 text-chrome-dense text-muted-foreground">
      {#if removal === "deleting"}
        <span class="flex shrink-0 items-center gap-1.5 self-center text-foreground">
          <LoaderCircle size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />Deleting…
        </span>
      {:else if removal === "waiting"}
        <span class="shrink-0">Waiting to delete</span>
      {:else}
        <span class="shrink-0 {worktreeState === 'unsaved' ? 'text-warning' : worktreeState === 'in_use' ? 'text-foreground' : ''}">{worktreeStatusText(worktree)}</span>
        {#if isSessionOpen && worktreeState !== "in_use"}
          <span aria-hidden="true">·</span><span class="shrink-0">Session open</span>
        {/if}
        {#if lastUsed}
          <span aria-hidden="true">·</span><span class="truncate">{lastUsed}</span>
        {/if}
      {/if}
    </p>
  </div>

  <div class="flex w-16 shrink-0 justify-end text-chrome-dense text-muted-foreground tabular-nums @max-[30rem]/pane:hidden">
    {#if bytes === undefined}
      <Skeleton class="h-2.5 w-11 rounded-[0.1875rem] opacity-60" aria-label="Measuring the size" />
    {:else if bytes !== null}
      {formatResourceBytes(bytes)}
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-0.5">
    <Button
      size="icon-sm"
      variant="ghost"
      class="text-muted-foreground pointer-coarse:tap-area {openSessionId ? '' : 'invisible'}"
      title="Open session"
      aria-label="Open the session of {worktree.title}"
      tabindex={openSessionId ? undefined : -1}
      onclick={() => { if (openSessionId) onOpenSession(openSessionId); }}
    >
      <OpenIcon size={16} />
    </Button>
    <span title={worktreeState === "in_use" ? "A turn is running here. Wait for it to end, or stop it." : undefined}>
      <Button
        bind:ref={deleteButtonEl}
        size="icon-sm"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive pointer-coarse:tap-area"
        disabled={isRemoving || worktreeState === "in_use"}
        title={worktreeState === "in_use" ? undefined : "Delete"}
        aria-label="Delete {worktree.title}"
        onclick={() => {
          removeError = "";
          isConfirming = true;
        }}
      >
        <TrashIcon size={16} />
      </Button>
    </span>
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
  </div>
</div>
