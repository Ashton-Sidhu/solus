<script lang="ts">
  /** The worktrees and task folders that Solus made on this host, grouped by
   *  project or codebase, with a project filter and a status filter. The host
   *  reads them when the page opens; their sizes arrive after the list. */
  import { untrack } from "svelte";
  import { AlertDialog } from "bits-ui";
  import { CircleDashed as CircleDashedIcon, Folder as FolderIcon, FolderGit2 as WorktreeIcon, LoaderCircle, RefreshCw, Trash2 } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { diskFreeText, formatResourceBytes } from "@solus/client-core/host-resource-watch";
  import { worktreeStatusText } from "@solus/client-core/managed-worktrees";
  import { managedWorktreeState, type ManagedWorktree } from "@solus/contracts/git-types";
  import { getWorkspaceContext } from "../../contexts";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../ui/button";
  import { RowCard } from "../ui/row-card";
  import { ListBulkBar, ListFilterGroup, ListFilterMenu, ListSelection } from "../ui/list-page";
  import ManagedWorktreeRow from "./ManagedWorktreeRow.svelte";
  import ManagedWorktreesSkeleton from "./ManagedWorktreesSkeleton.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { managedWorktreesForHost, type WorktreeRemovalFailure } from "./managed-worktrees.store.svelte";
  import {
    deleteSummaryText,
    projectFilterOptions,
    statusFilterOptions,
    totalSize,
    worktreeGroupOptions,
    worktreeGroups,
    type WorktreeStatusFilter,
  } from "./lib/managed-worktrees";

  interface Props {
    serverId: string;
    api: HostApi;
    label: string;
    description?: string;
    visible?: boolean;
  }
  let { serverId, api, label, description, visible = true }: Props = $props();

  const workspace = getWorkspaceContext();
  const store = $derived(managedWorktreesForHost(serverId));
  let groupFilter = $state("all");
  let statusFilter = $state<WorktreeStatusFilter>("all");
  const selection = new ListSelection();
  let confirmation = $state.raw<ManagedWorktree[] | null>(null);
  let failures = $state.raw<WorktreeRemovalFailure[]>([]);
  let removalStatus = $state("");

  const groupOptions = $derived(worktreeGroupOptions(store.worktrees));
  // A group whose last worktree was deleted is no choice: show all again.
  const activeGroupKey = $derived(groupOptions.some((option) => option.key === groupFilter) ? groupFilter : "all");
  const groups = $derived(worktreeGroups(store.worktrees, activeGroupKey, statusFilter));
  const shownWorktrees = $derived(groups.flatMap((view) => view.shown));
  const selectableWorktrees = $derived(shownWorktrees.filter((worktree) => managedWorktreeState(worktree) !== "in_use"));
  const selectedWorktrees = $derived(selectableWorktrees.filter((worktree) => selection.has(worktree.path)));
  const losesWork = $derived(confirmation?.some((worktree) => managedWorktreeState(worktree) === "unsaved") ?? false);
  const canDeleteSelection = $derived(!store.isRemoving && !store.loading && !store.error);
  const shownSize = $derived(totalSize(shownWorktrees, store.sizes));
  const showBulkBar = $derived(!store.error && (selectedWorktrees.length > 0 || confirmation !== null));
  const activeFilterCount = $derived(Number(activeGroupKey !== "all") + Number(statusFilter !== "all"));

  function clearFilters() {
    groupFilter = "all";
    statusFilter = "all";
  }

  $effect(() => {
    const target = store;
    const targetApi = api;
    untrack(() => void target.load(targetApi));
  });

  $effect(() => {
    selection.setOrder(selectableWorktrees.map((worktree) => worktree.path));
    untrack(() => selection.retainVisible());
  });

  useScope("modal-dialog", { exclusive: true, pre: true, active: () => visible && confirmation !== null });

  async function removeSelected() {
    if (!confirmation || !canDeleteSelection) return;
    const worktrees = confirmation;
    confirmation = null;
    failures = [];
    removalStatus = "";
    failures = await store.removeMany(api, worktrees);
    const removed = worktrees.length - failures.length;
    removalStatus = removed > 0 ? `Deleted ${removed} ${removed === 1 ? "worktree" : "worktrees"}.` : "";
  }

  function onListKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || confirmation) return;
    if (event.key === "Escape" && selection.active) {
      event.preventDefault();
      event.stopPropagation();
      selection.clear();
      return;
    }
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-selectable-worktree]")
      : null;
    const worktreePath = row?.dataset.selectableWorktree;
    if (!worktreePath || !canDeleteSelection || event.altKey) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "a") {
      event.preventDefault();
      event.stopPropagation();
      selection.selectAllVisible();
    } else if (!event.metaKey && !event.ctrlKey && key === "x") {
      event.preventDefault();
      event.stopPropagation();
      selection.toggle(worktreePath, event);
    }
  }

  function openSession(sessionId: string) {
    void workspace.revealSession(sessionId, serverId);
  }
</script>

<SettingsSection {label} {description} {visible} plain>
  {#snippet action()}
    <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" disabled={store.loading || store.isRemoving}
      onclick={() => void store.load(api)} aria-label="Read the worktrees again" title="Read the worktrees again">
      <RefreshCw size={14} class={store.loading ? "animate-spin motion-reduce:animate-none" : ""} />
    </Button>
  {/snippet}

  <!-- While the bar floats over the pane, the list gets room to scroll out from under it. -->
  <div class="flex flex-col gap-5 {showBulkBar ? 'pb-16' : ''}" role="presentation" onkeydown={onListKeydown}>
    {#if store.loaded && store.worktrees.length > 0}
      <div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2">
        <span class="min-w-0 truncate text-chrome-dense text-muted-foreground tabular-nums">
          {shownWorktrees.length} {shownWorktrees.length === 1 ? "worktree" : "worktrees"}{shownSize !== null ? ` · ${formatResourceBytes(shownSize)}` : ""}
        </span>
        {#if store.disk}
          <span class="shrink-0 text-chrome-dense text-muted-foreground tabular-nums" title="Free space on the disk that holds the Solus data folder">
            · {diskFreeText(store.disk)} on disk
          </span>
        {/if}
        <div class="ml-auto text-workspace-chrome">
          <ListFilterMenu activeCount={activeFilterCount} onClear={clearFilters}>
            <ListFilterGroup label="Project" icon={FolderIcon} options={projectFilterOptions(store.worktrees)} selected={[activeGroupKey]} onChange={([next]) => (groupFilter = next ?? "all")} />
            <ListFilterGroup label="Status" icon={CircleDashedIcon} options={statusFilterOptions(store.worktrees, activeGroupKey)} selected={[statusFilter]} onChange={([next]) => (statusFilter = next ?? "all")} />
          </ListFilterMenu>
        </div>
      </div>
    {/if}

    {#if removalStatus}
      <p class="text-chrome-dense text-muted-foreground" role="status">{removalStatus}</p>
    {/if}
    {#if failures.length}
      <ul class="space-y-1 text-chrome-dense text-(--solus-status-error)" role="alert">
        {#each failures as failure (failure.path)}
          <li class="break-words"><span class="font-medium">{failure.title}.</span> {failure.error}</li>
        {/each}
      </ul>
    {/if}

    {#if store.error}
      <p class="text-chrome-dense text-(--solus-status-error)" role="alert">{store.error}</p>
    {:else if !store.loaded}
      <ManagedWorktreesSkeleton />
    {:else if store.worktrees.length === 0}
      <RowCard>
        <div class="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
          <span class="mb-1 flex size-9 items-center justify-center rounded-lg bg-(--solus-surface-secondary) text-muted-foreground">
            <WorktreeIcon size={18} aria-hidden="true" />
          </span>
          <p class="text-sm font-medium text-foreground">No worktrees on this host</p>
          <p class="max-w-[42ch] text-pretty text-chrome-dense text-muted-foreground">A session that starts in its own worktree adds one here.</p>
        </div>
      </RowCard>
    {:else if groups.length === 0}
      <RowCard>
        <p class="px-4 py-6 text-center text-chrome-dense text-muted-foreground">No worktrees match these filters.</p>
      </RowCard>
    {:else}
      {#each groups as view (view.group.key)}
        {@const groupSize = totalSize(view.all, store.sizes)}
        <section class="flex flex-col gap-2" aria-label={view.group.name}>
          <div class="flex min-w-0 items-baseline gap-2 px-1">
            <h3 class="shrink-0 text-sm font-medium text-foreground">{view.group.name}</h3>
            <span class="min-w-0 truncate text-chrome-dense text-muted-foreground" title={view.group.detail}>{view.group.detail}</span>
            <span class="ml-auto shrink-0 text-chrome-dense text-muted-foreground tabular-nums">
              {view.all.length} {view.all.length === 1 ? "worktree" : "worktrees"}{groupSize !== null ? ` · ${formatResourceBytes(groupSize)}` : ""}
            </span>
          </div>
          <RowCard>
            {#each view.shown as worktree (worktree.path)}
              <ManagedWorktreeRow
                {worktree}
                bytes={store.sizes.get(worktree.path)}
                isRemoving={store.isRemoving}
                removal={store.removalOf(worktree.path)}
                {selection}
                onRemove={() => store.remove(api, worktree)}
                onOpenSession={openSession}
              />
            {/each}
          </RowCard>
        </section>
      {/each}
    {/if}

    {#if store.notice}
      <p class="text-chrome-dense whitespace-pre-line text-muted-foreground" role="status">{store.notice}</p>
    {/if}

    {#if showBulkBar}
      <AlertDialog.Root open={confirmation !== null} onOpenChange={(open) => {
        confirmation = open ? $state.snapshot(selectedWorktrees) : null;
      }}>
        <!-- The bar floats over the bottom of the settings pane, as on Tasks, in
             the Tasks list's type size. -->
        <div class="contents text-chrome-dense">
          <ListBulkBar {selection}>
            <AlertDialog.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-[#cf222e] transition-colors duration-100 enabled:hover:bg-[#cf222e]/10 disabled:cursor-default disabled:opacity-50 @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome [.dark_&]:text-[#f85149] [.dark_&]:enabled:hover:bg-[#f85149]/10"
                  disabled={!canDeleteSelection}
                  title="Delete the selected worktrees"
                >
                  {#if store.isRemoving}
                    <LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />
                    Deleting…
                  {:else}
                    <Trash2 size={14} class="shrink-0" />
                    Delete
                  {/if}
                </button>
              {/snippet}
            </AlertDialog.Trigger>
          </ListBulkBar>
        </div>
        {#if confirmation}
          <AlertDialog.Portal>
            <AlertDialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop" />
            <AlertDialog.Content class="fixed top-1/2 left-1/2 z-[10001] flex max-h-[min(36rem,calc(100dvh-2rem))] w-[min(26rem,calc(100vw-2rem))] -translate-1/2 flex-col gap-3.5 rounded-[14px] bg-(--popover) p-4 text-workspace-chrome shadow-[0_0_0_0.5px_var(--hairline-strongest),0_0.5rem_1rem_-0.5rem_rgba(0,0,0,0.18),0_2rem_3rem_-1.5rem_rgba(0,0,0,0.34)]">
              <div class="flex flex-col gap-1">
                <AlertDialog.Title class="font-medium text-foreground">
                  Delete {confirmation.length} {confirmation.length === 1 ? "worktree" : "worktrees"}?
                </AlertDialog.Title>
                <AlertDialog.Description class="text-pretty text-(--solus-text-secondary)">
                  {deleteSummaryText(confirmation, store.sizes)}
                </AlertDialog.Description>
              </div>
              <ul class="min-h-0 list-disc space-y-1 overflow-y-auto pl-5 text-foreground marker:text-muted-foreground">
                {#each confirmation as worktree (worktree.path)}
                  <li class="break-words">
                    {worktree.title}{#if managedWorktreeState(worktree) === "unsaved"}<span class="text-warning"> ({worktreeStatusText(worktree).toLowerCase()})</span>{/if}
                  </li>
                {/each}
              </ul>
              <div class="flex justify-end gap-1.5">
                <AlertDialog.Cancel>
                  {#snippet child({ props })}
                    <Button {...props} variant="ghost" size="sm" class="pointer-coarse:min-h-11">Cancel</Button>
                  {/snippet}
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  {#snippet child({ props })}
                    <Button {...props} variant="destructive" size="sm" class="pointer-coarse:min-h-11" disabled={!canDeleteSelection} onclick={() => void removeSelected()}>
                      {losesWork ? "Delete and lose work" : "Delete"}
                    </Button>
                  {/snippet}
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        {/if}
      </AlertDialog.Root>
    {/if}
  </div>
</SettingsSection>
