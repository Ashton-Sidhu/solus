<script lang="ts">
  /** The worktrees and task folders that Solus made on this host, grouped by
   *  project or codebase, with a project filter and a status filter. The host
   *  reads them when the page opens; their sizes arrive after the list. */
  import { untrack } from "svelte";
  import { ChevronDown as CaretDownIcon, RefreshCw } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { RowCard } from "../ui/row-card";
  import * as Tabs from "../ui/tabs";
  import ManagedWorktreeRow from "./ManagedWorktreeRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { managedWorktreesForHost } from "./managed-worktrees.store.svelte";
  import {
    WORKTREE_STATUS_FILTERS,
    formatSize,
    statusCount,
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
  const activeGroupName = $derived(groupOptions.find((option) => option.key === activeGroupKey)?.name ?? "All projects");

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
      <div class="flex flex-wrap items-center gap-2">
        <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" size="sm" class="max-w-56 justify-between text-workspace-chrome font-normal shadow-xs" aria-label="Project">
                <span class="truncate">{activeGroupName}</span>
                <CaretDownIcon size={11} class="opacity-60" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="w-[min(18rem,calc(100vw-2rem))]">
            <DropdownMenu.RadioGroup value={activeGroupKey} onValueChange={(value) => (groupFilter = value)}>
              <DropdownMenu.RadioItem value="all">
                <span class="flex-1 truncate">All projects</span>
                <span class="text-chrome-dense text-muted-foreground tabular-nums">{store.worktrees.length}</span>
              </DropdownMenu.RadioItem>
              {#each groupOptions as option (option.key)}
                <DropdownMenu.RadioItem value={option.key}>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{option.name}</span>
                    <span class="truncate text-chrome-dense text-muted-foreground">{option.detail}</span>
                  </span>
                  <span class="text-chrome-dense text-muted-foreground tabular-nums">{option.count}</span>
                </DropdownMenu.RadioItem>
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <Tabs.Root value={statusFilter} onValueChange={(value) => (statusFilter = value as WorktreeStatusFilter)}>
          <Tabs.List aria-label="Show">
            {#each WORKTREE_STATUS_FILTERS as filter (filter.value)}
              <Tabs.Trigger value={filter.value} class="text-workspace-chrome">
                {filter.label}
                <span class="text-muted-foreground tabular-nums">{statusCount(store.worktrees, activeGroupKey, filter.value)}</span>
              </Tabs.Trigger>
            {/each}
          </Tabs.List>
        </Tabs.Root>

        <span class="ml-auto text-chrome-dense text-muted-foreground tabular-nums">
          {shownWorktrees.length} {shownWorktrees.length === 1 ? "worktree" : "worktrees"}{shownSize !== null ? ` · ${formatSize(shownSize)}` : ""}
        </span>
      </div>
    {/if}

    {#if store.error}
      <p class="text-chrome-dense text-(--solus-status-error)" role="alert">{store.error}</p>
    {:else if !store.loaded}
      <p class="text-chrome-dense text-muted-foreground">Reading the worktrees…</p>
    {:else if store.worktrees.length === 0}
      <p class="text-chrome-dense text-muted-foreground">No worktrees. A session that starts in a new worktree adds one here.</p>
    {:else if groups.length === 0}
      <p class="text-chrome-dense text-muted-foreground">No worktrees match these filters.</p>
    {:else}
      {#each groups as view (view.group.key)}
        {@const groupSize = totalSize(view.all, store.sizes)}
        <section class="flex flex-col gap-2" aria-label={view.group.name}>
          <div class="flex min-w-0 items-baseline gap-2">
            <h3 class="shrink-0 text-sm font-medium text-foreground">{view.group.name}</h3>
            <span class="min-w-0 truncate text-chrome-dense text-muted-foreground" title={view.group.detail}>{view.group.detail}</span>
            <span class="ml-auto shrink-0 text-chrome-dense text-muted-foreground tabular-nums">
              {view.all.length}{groupSize !== null ? ` · ${formatSize(groupSize)}` : ""}
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
