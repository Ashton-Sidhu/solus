<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Check, Download, ExternalLink, LoaderCircle, Plus } from "@lucide/svelte";
  import { SearchField } from "../ui/search-field";
  import { getWorkspaceContext, hostCapabilitiesStore } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { RemoteSkill } from "@solus/contracts/types";
  import { supportsSettingsSurface } from "@solus/client-core/host-capabilities";
  import { skillsForHost, ListWindow, SkillSearch } from "./skills.store.svelte";

  interface Props { serverId: string; api: HostApi; hostLabel: string }
  let { serverId, api, hostLabel }: Props = $props();
  const workspace = getWorkspaceContext();
  const search = new SkillSearch();
  const inventory = $derived(skillsForHost(serverId));
  const capabilities = $derived(hostCapabilitiesStore.for(serverId));
  const isSupported = $derived(supportsSettingsSurface(capabilities, "skills"));
  const canInstall = $derived(capabilities?.skillsInstall === true);
  const canManage = $derived(capabilities?.skillsManage === true);
  // The page is the installed list. Adding is a mode the user enters and leaves,
  // so only one input — filter or registry search — is ever on screen.
  let isAdding = $state(false);
  let query = $state("");
  let filter = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  let filterEl = $state<HTMLInputElement | null>(null);
  let confirmRemove = $state<string | null>(null);
  const matchingSkills = $derived(inventory.matching(filter));
  // A new window per list identity: paging restarts when the filter or results change.
  const installedWindow = $derived.by(() => { void matchingSkills; return new ListWindow(); });
  const resultsWindow = $derived.by(() => { void search.results; return new ListWindow(); });
  const visibleSkills = $derived(installedWindow.slice(matchingSkills));
  const visibleResults = $derived(resultsWindow.slice(search.results));
  const installedLabel = $derived(inventory.loaded && inventory.skills.length > 0 ? `Installed skills · ${inventory.skills.length}` : "Installed skills");

  $effect(() => { void hostCapabilitiesStore.load(serverId); });
  $effect(() => {
    const targetApi = api;
    const targetInventory = inventory;
    confirmRemove = null;
    filter = "";
    if (canManage) void targetInventory.load(targetApi);
  });
  $effect(() => {
    const value = query;
    const targetApi = api;
    const supported = isSupported;
    search.cancel();
    const timer = setTimeout(() => { if (supported) void search.search(targetApi, value); }, 350);
    return () => { clearTimeout(timer); search.cancel(); };
  });
  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    const targetInventory = inventory;
    if (!canManage) return;
    return serverConnections.onStatusChange((changedServerId, status) => {
      if (changedServerId === targetServerId && status === "connected") void targetInventory.load(targetApi);
    });
  });
  onMount(() => { filterEl?.focus(); });

  async function openAdd() {
    isAdding = true;
    await tick();
    searchEl?.focus();
  }

  async function closeAdd() {
    isAdding = false;
    query = "";
    await tick();
    filterEl?.focus();
  }

  function refreshCommands(targetServerId: string) {
    const activeTabId = workspace.activeTabId;
    const activeServerId = (activeTabId ? workspace.runFor(activeTabId)?.serverId : undefined)
      ?? serverConnections.defaultServerId();
    if (activeServerId !== targetServerId) return;
    const cwd = workspace.activeSession?.run.workingDirectory ?? workspace.globalDefaults.workingDirectory;
    void workspace.refreshPluginCommands(cwd, activeTabId || undefined);
  }

  async function install(skill: RemoteSkill) {
    const targetServerId = serverId;
    if (await inventory.install(api, skill, canManage)) refreshCommands(targetServerId);
    if (targetServerId === serverId) searchEl?.focus();
  }

  async function remove(name: string) {
    const targetServerId = serverId;
    if (await inventory.remove(api, name)) {
      refreshCommands(targetServerId);
      if (targetServerId === serverId) { confirmRemove = null; filterEl?.focus(); }
    }
  }
</script>

{#snippet showMore(window: ListWindow, total: number)}
  {#if window.remaining(total) > 0}
    <button type="button"
      class="flex w-full cursor-pointer items-center justify-center gap-1.5 border-t border-border px-4 py-3 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none [.is-laptop-display_&]:px-3.5 [.is-laptop-display_&]:py-2 [@media(pointer:coarse)]:min-h-11"
      onclick={() => window.showMore()}>
      Show {Math.min(ListWindow.PAGE, window.remaining(total))} more
      <span class="text-[0.875em] opacity-70">· {window.remaining(total)} remaining</span>
    </button>
  {/if}
{/snippet}

{#if capabilities === undefined}
  <p class="py-8 text-center text-workspace-chrome text-muted-foreground" role="status">Checking skill support…</p>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Skills" {hostLabel} />
{:else}
  {#if inventory.message}<p class="px-0.5 text-workspace-chrome text-(--solus-accent)" role="status">{inventory.message}</p>{/if}

  {#if isAdding}
    <SettingsSection label="Add from skills.sh" description="Installs for every agent and project on {hostLabel}.">
      {#snippet action()}
        <Button variant="ghost" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={closeAdd}>Done</Button>
      {/snippet}
      <div class="flex items-center border-b border-border">
        <SearchField bind:ref={searchEl} bind:value={query} placeholder="Search skills.sh…"
          class="min-h-11 rounded-none border-0 px-4 py-2.5 text-workspace-chrome focus-within:border-0 [.is-laptop-display_&]:min-h-10 [.is-laptop-display_&]:px-3.5 [.is-laptop-display_&]:py-2 [&_input]:text-workspace-chrome"
          onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); void closeAdd(); } }} />
      </div>
      {#if !query.trim()}
        <p class="p-8 text-center text-workspace-chrome text-muted-foreground [.is-laptop-display_&]:p-6">Type to search the skills.sh registry.</p>
      {:else if search.error}
        <div class="flex flex-wrap items-center justify-between gap-3 p-4">
          <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{search.error}</p>
          <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => search.search(api, query)}>Retry</Button>
        </div>
      {:else if search.searching || !search.hasSearched}
        <p class="flex items-center justify-center gap-2 p-8 text-workspace-chrome text-muted-foreground [.is-laptop-display_&]:p-6" role="status"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Searching skills.sh…</p>
      {:else if search.results.length === 0}
        <p class="p-8 text-center text-workspace-chrome text-muted-foreground [.is-laptop-display_&]:p-6">No skills found for “{query.trim()}”.</p>
      {:else}
        {#each visibleResults as skill (skill.id)}
          <SettingsRow label={skill.name} description={skill.repo} testId="skill-row" bodyVisible={inventory.errors.has(skill.id)}>
            {#snippet labelExtra()}
              <a href={skill.url} onclick={(event) => { event.preventDefault(); localApi.openExternal(skill.url); }}
                class="ml-1.5 inline-flex align-middle text-muted-foreground hover:text-foreground" aria-label="Open {skill.name} on skills.sh">
                <ExternalLink size={14} />
              </a>
            {/snippet}
            {#snippet control()}
              <div class="flex items-center gap-3 [.is-laptop-display_&]:gap-2.5">
                {#if skill.installs}<span class="text-[0.875em] tabular-nums text-muted-foreground @max-[30rem]/pane:hidden">{skill.installs} installs</span>{/if}
                {#if inventory.isInstalled(skill)}
                  <div class="flex items-center gap-1.5 text-workspace-chrome text-(--solus-accent)" data-testid="skill-installed"><Check size={14} />Installed</div>
                {:else}
                  <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => install(skill)} disabled={inventory.busy !== null || !canInstall} data-testid="skill-install">
                    {#if inventory.busy === skill.id}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Installing…
                    {:else}<Download size={14} />Install{/if}
                  </Button>
                {/if}
              </div>
            {/snippet}
            {#snippet body()}
              {#if inventory.errors.get(skill.id)}<p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{inventory.errors.get(skill.id)}</p>{/if}
            {/snippet}
          </SettingsRow>
        {/each}
        {@render showMore(resultsWindow, search.results.length)}
      {/if}
    </SettingsSection>
  {:else}
    <SettingsSection label={installedLabel} description="Available to every agent and project on {hostLabel}.">
      {#snippet action()}
        <div class="flex items-center gap-1">
          {#if canManage}<Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground [@media(pointer:coarse)]:min-h-11" onclick={() => inventory.load(api)} disabled={inventory.loading || inventory.busy !== null}>Refresh</Button>{/if}
          <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={openAdd} disabled={!canInstall}><Plus size={14} />Add skill</Button>
        </div>
      {/snippet}
      {#if !canManage}
        <p class="p-4 text-workspace-chrome text-muted-foreground">Update Solus on {hostLabel} to manage installed skills.</p>
      {:else}
        {#if inventory.skills.length > 0}
          <div class="flex items-center border-b border-border">
            <SearchField bind:ref={filterEl} bind:value={filter} placeholder="Filter installed skills…"
              class="min-h-11 rounded-none border-0 px-4 py-2.5 text-workspace-chrome focus-within:border-0 [.is-laptop-display_&]:min-h-10 [.is-laptop-display_&]:px-3.5 [.is-laptop-display_&]:py-2 [&_input]:text-workspace-chrome" />
          </div>
        {/if}
        {#if inventory.error}
          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{inventory.error}</p>
            <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => inventory.load(api)} disabled={inventory.loading}>Retry</Button>
          </div>
        {/if}
        {#if inventory.loading && !inventory.loaded}
          <p role="status" class="flex items-center justify-center gap-2 p-8 text-workspace-chrome text-muted-foreground [.is-laptop-display_&]:p-6"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Loading installed skills…</p>
        {/if}
        {#if inventory.loaded && !inventory.error && matchingSkills.length === 0}
          <p class="p-8 text-center text-workspace-chrome text-muted-foreground [.is-laptop-display_&]:p-6">{filter.trim() ? `No installed skills match “${filter.trim()}”.` : "No skills installed yet. Use Add skill to install one from skills.sh."}</p>
        {/if}
        {#each visibleSkills as skill (skill.path)}
          <SettingsRow label={skill.name} description={skill.source ?? "Local"} testId="global-skill-row" bodyVisible={confirmRemove === skill.path || inventory.errors.has(skill.name)}>
            {#snippet control()}
              <div class="flex items-center gap-3 [.is-laptop-display_&]:gap-2.5">
                <div class="flex items-center gap-1 @max-[36rem]/pane:hidden" aria-label="Agents: {skill.agents.join(', ')}">
                  {#each skill.agents as agent (agent)}
                    <span class="whitespace-nowrap rounded-md border border-border px-1.5 py-px text-[0.8em] leading-[1.6] text-muted-foreground">{agent}</span>
                  {/each}
                </div>
                <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground hover:text-destructive [@media(pointer:coarse)]:min-h-11" onclick={() => { confirmRemove = skill.path; }} disabled={inventory.busy !== null || !!inventory.error || inventory.loading} aria-label="Remove {skill.name}">Remove</Button>
              </div>
            {/snippet}
            {#snippet body()}
              <div class="flex flex-col gap-3">
                <p class="break-all text-[0.875em] text-muted-foreground">{skill.path}</p>
                {#if confirmRemove === skill.path}
                  <p class="text-pretty text-workspace-chrome">Remove {skill.name} from all agents and projects on {hostLabel}? Local skill files may be deleted.</p>
                  <div class="flex flex-wrap gap-2">
                    <Button variant="destructive" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => remove(skill.name)} disabled={inventory.busy !== null}>{inventory.busy === skill.name ? "Removing…" : "Remove skill"}</Button>
                    <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => { confirmRemove = null; }} disabled={inventory.busy !== null}>Cancel</Button>
                  </div>
                {/if}
                {#if inventory.errors.get(skill.name)}<p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{inventory.errors.get(skill.name)}</p>{/if}
              </div>
            {/snippet}
          </SettingsRow>
        {/each}
        {@render showMore(installedWindow, matchingSkills.length)}
      {/if}
    </SettingsSection>
  {/if}
{/if}
