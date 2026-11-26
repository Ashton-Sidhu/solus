<script lang="ts">
  /** The worktrees and task folders that Solus made on this host, grouped by
   *  project or codebase, with a project filter and a status filter. The host
   *  reads them when the page opens; their sizes arrive after the list. */
  import { untrack } from "svelte";
  import { CircleDashed as CircleDashedIcon, Folder as FolderIcon, FolderGit2 as WorktreeIcon, RefreshCw } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { diskFreeText, formatResourceBytes } from "@solus/client-core/host-resource-watch";
  import { getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import { RowCard } from "../ui/row-card";
  import { ListFilterGroup, ListFilterMenu } from "../ui/list-page";
  import ManagedWorktreeRow from "./ManagedWorktreeRow.svelte";
  import ManagedWorktreesSkeleton from "./ManagedWorktreesSkeleton.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { managedWorktreesForHost } from "./managed-worktrees.store.svelte";
  import {
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

  const groupOptions = $derived(worktreeGroupOptions(store.worktrees));
  // A group whose last worktree was deleted is no choice: show all again.
  const activeGroupKey = $derived(groupOptions.some((option) => option.key === groupFilter) ? groupFilter : "all");
  const groups = $derived(worktreeGroups(store.worktrees, activeGroupKey, statusFilter));
  const shownWorktrees = $derived(groups.flatMap((view) => view.shown));
  const shownSize = $derived(totalSize(shownWorktrees, store.sizes));
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

  function openSession(sessionId: string) {
    void workspace.revealSession(sessionId, serverId);
  }
</script>

<SettingsSection {label} {description} {visible} plain>
  {#snippet action()}
    <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" disabled={store.loading}
      onclick={() => void store.load(api)} aria-label="Read the worktrees again" title="Read the worktrees again">
      <RefreshCw size={14} class={store.loading ? "animate-spin motion-reduce:animate-none" : ""} />
    </Button>
  {/snippet}

  <div class="flex flex-col gap-5">
    {#if store.loaded && store.worktrees.length > 0}
      <div class="flex min-w-0 items-center gap-1">
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
                isRemoving={store.removing === worktree.path}
                onRemove={() => store.remove(api, worktree)}
                onOpenSession={openSession}
              />
            {/each}
          </RowCard>
        </section>
      {/each}
    {/if}

    {#if store.notice}
      <p class="text-chrome-dense text-muted-foreground" role="status">{store.notice}</p>
    {/if}
  </div>
</SettingsSection>
