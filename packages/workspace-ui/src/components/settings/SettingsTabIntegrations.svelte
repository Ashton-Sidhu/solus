<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["integration", "integrations", "mcp", "server", "catalog", "integrations.sh", "remote tools"];
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { ChevronRight, LoaderCircle, Search, TriangleAlert } from "@lucide/svelte";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import { integrationsStore } from "./integrations.store.svelte";
  import { IntegrationAddFlow } from "./lib/integration-add.svelte";
  import { authKindLabel, firstLine, urlHost } from "./lib/integration-labels";
  import { wordsMatch } from "./lib/settings-search";
  import { toasts } from "../../lib/toasts";

  interface Props { serverId: string; hostLabel: string; searchQuery?: string }
  let { serverId, hostLabel, searchQuery = "" }: Props = $props();

  // The page is keyed by host, so one flow serves one host for its whole life.
  const flow = new IntegrationAddFlow(untrack(() => serverId));
  const expanded = new SvelteSet<string>();
  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");
  let confirmRemoveId = $state<string | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const visibleIntegrations = $derived(
    (hostState?.integrations ?? []).filter((integration) => !searchQuery || wordsMatch(searchQuery, [integration.name, integration.slug])),
  );
  const isBusy = $derived(!!hostState?.saving);
  const isOffline = $derived(!!hostState?.isDisconnected);

  $effect(() => {
    const hostId = serverId;
    return untrack(() => integrationsStore.watch(hostId));
  });
  onDestroy(() => flow.dispose());

  function toggleTools(integration: Integration) {
    if (expanded.has(integration.id)) {
      expanded.delete(integration.id);
      return;
    }
    expanded.add(integration.id);
    if (!hostState?.tools.has(integration.id)) void integrationsStore.loadTools(serverId, integration.id);
  }

  function startRename(integration: Integration) {
    confirmRemoveId = null;
    renamingId = integration.id;
    renameDraft = integration.name;
  }

  async function saveRename(integration: Integration) {
    const name = renameDraft.trim();
    if (!name || name === integration.name) { renamingId = null; return; }
    if (await integrationsStore.update(serverId, { id: integration.id, name })) renamingId = null;
  }

  async function remove(integration: Integration) {
    if (await integrationsStore.remove(serverId, integration.id)) {
      confirmRemoveId = null;
      toasts.success(`${integration.name} removed`);
      searchEl?.focus();
    }
  }

  async function add() {
    const integration = await flow.add();
    if (!integration) return;
    toasts.success(`${integration.name} added`);
    await tick();
    searchEl?.focus();
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      flow.moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      flow.selectActive();
    } else if (event.key === "Escape" && flow.query) {
      event.preventDefault();
      event.stopPropagation();
      flow.setQuery("");
    }
  }
</script>

{#snippet statusLine(text: string)}
  <p role="status" class="flex items-center justify-center gap-2 p-6 text-workspace-chrome text-muted-foreground">
    <LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />{text}
  </p>
{/snippet}

{#snippet tools(integration: Integration)}
  {@const list = hostState?.tools.get(integration.id)}
  {@const toolError = hostState?.toolErrors.get(integration.id)}
  {#if toolError}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{toolError}</p>
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.loadTools(serverId, integration.id)}>Retry</Button>
    </div>
  {:else if !list}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Loading tools…</p>
  {:else if list.length === 0}
    <p class="text-workspace-chrome text-muted-foreground">
      {integration.auth.kind === "none" ? "This integration lists no tools." : "Its tools show after sign-in, which arrives in a later release."}
    </p>
  {:else}
    <ul class="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Tools of {integration.name}">
      {#each list as tool (tool.name)}
        <li class="flex min-w-0 flex-col gap-0.5 px-3 py-2">
          <div class="flex min-w-0 items-center gap-1.5">
            <code class="truncate font-[family-name:var(--solus-code-font-family)] text-[length:var(--solus-code-font-size)] text-foreground">{tool.name}</code>
            {#if tool.destructive}
              <span class="shrink-0 rounded-full border border-destructive/40 px-1.5 py-px text-[11px] leading-[1.5] text-destructive">destructive</span>
            {:else if tool.readOnly}
              <span class="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] leading-[1.5] text-muted-foreground">read-only</span>
            {/if}
          </div>
          {#if firstLine(tool.description)}
            <p class="truncate text-chrome-dense text-(--solus-text-secondary)" title={tool.description}>{firstLine(tool.description)}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#if !hostState || (hostState.loading && hostState.integrations === null && !hostState.isUnsupported)}
  {@render statusLine("Loading integrations…")}
{:else if hostState.isUnsupported}
  <SettingsHostUnsupported feature="Integrations" {hostLabel} />
{:else}
  <div class="flex flex-col gap-8">
    <SettingsSection label="Integrations" description="Remote MCP servers. Their tools reach every agent on {hostLabel}.">
      {#if isOffline}
        <div class="flex items-center gap-2 p-4 text-workspace-chrome text-muted-foreground" role="status">
          <TriangleAlert size={14} class="shrink-0" />{hostLabel} is disconnected. This list updates when it reconnects.
        </div>
      {:else if hostState.error}
        <div class="flex flex-wrap items-center justify-between gap-3 p-4">
          <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{hostState.error}</p>
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.load(serverId)} disabled={hostState.loading}>Retry</Button>
        </div>
      {/if}
      {#if hostState.integrations && visibleIntegrations.length === 0}
        <p class="p-6 text-center text-workspace-chrome text-muted-foreground">
          {hostState.integrations.length === 0 ? "No integrations yet" : `No integrations match “${searchQuery}”.`}
        </p>
      {/if}
      {#each visibleIntegrations as integration (integration.id)}
        {@const isExpanded = expanded.has(integration.id)}
        <SettingsRow
          label={integration.name}
          description="{integration.slug} · {urlHost(integration.url)}"
          testId="integration-row"
          bodyVisible={isExpanded || renamingId === integration.id || confirmRemoveId === integration.id}
        >
          {#snippet labelExtra()}
            <span class="ml-1.5 inline-block rounded-full border border-border px-1.5 py-px align-[0.1em] text-[11px] leading-[1.5] font-normal text-muted-foreground">{authKindLabel(integration.auth)}</span>
          {/snippet}
          {#snippet control()}
            <div class="flex items-center gap-1">
              <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" aria-expanded={isExpanded} onclick={() => toggleTools(integration)}>
                <ChevronRight size={14} class="transition-transform motion-reduce:transition-none {isExpanded ? 'rotate-90' : ''}" />Tools
              </Button>
              <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={() => startRename(integration)} disabled={isBusy || isOffline}>Rename</Button>
              <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground hover:text-destructive pointer-coarse:min-h-11" onclick={() => { renamingId = null; confirmRemoveId = integration.id; }} disabled={isBusy || isOffline} aria-label="Remove {integration.name}">Remove</Button>
            </div>
          {/snippet}
          {#snippet body()}
            <div class="flex flex-col gap-3">
              {#if renamingId === integration.id}
                <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); void saveRename(integration); }}>
                  <!-- svelte-ignore a11y_autofocus -->
                  <Input bind:value={renameDraft} aria-label="Name of {integration.name}" class="h-8 max-w-xs flex-1 text-workspace-chrome" autofocus
                    onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); renamingId = null; } }} />
                  <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || !renameDraft.trim()}>{isBusy ? "Saving…" : "Save"}</Button>
                  <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { renamingId = null; }}>Cancel</Button>
                </form>
                <p class="text-chrome-dense text-muted-foreground">The tool prefix stays {integration.slug}.</p>
              {/if}
              {#if confirmRemoveId === integration.id}
                <p class="text-pretty text-workspace-chrome">Remove {integration.name}? Agents on {hostLabel} lose its tools.</p>
                <div class="flex flex-wrap gap-2">
                  <Button variant="destructive" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => remove(integration)} disabled={isBusy}>{isBusy ? "Removing…" : "Remove integration"}</Button>
                  <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { confirmRemoveId = null; }} disabled={isBusy}>Cancel</Button>
                </div>
              {/if}
              {#if (renamingId === integration.id || confirmRemoveId === integration.id) && hostState.writeError}
                <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{hostState.writeError}</p>
              {/if}
              {#if isExpanded}
                {@render tools(integration)}
              {/if}
            </div>
          {/snippet}
        </SettingsRow>
      {/each}
    </SettingsSection>

    <SettingsSection label="Add integration" description="Search the integrations.sh catalog, or type the address of an MCP server.">
      {#if flow.draft}
        {@const outcome = flow.outcome}
        <div class="flex flex-col gap-3 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <Input bind:value={flow.draft.name} aria-label="Integration name" class="h-8 max-w-xs flex-1 text-workspace-chrome" />
            <span class="min-w-0 truncate text-chrome-dense text-muted-foreground" title={flow.draft.url}>{flow.draft.url}</span>
          </div>
          {#if flow.probe.kind === "checking"}
            <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Checking {urlHost(flow.draft.url)}…</p>
          {:else if flow.probe.kind === "failed"}
            <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{flow.probe.error}</p>
          {:else if outcome}
            <p role="status" class="text-workspace-chrome {outcome.canAdd ? 'text-foreground' : 'text-(--solus-status-error)'}">{outcome.message}</p>
          {/if}
          {#if hostState.writeError && !renamingId && !confirmRemoveId}
            <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{hostState.writeError}</p>
          {/if}
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={add} disabled={!flow.canAdd || isBusy || isOffline}>{isBusy ? "Adding…" : "Add"}</Button>
            {#if flow.probe.kind === "failed" || outcome?.canRetry}
              <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => flow.runProbe()} disabled={isOffline}>Retry</Button>
            {/if}
            <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={async () => { flow.reset(); await tick(); searchEl?.focus(); }}>Cancel</Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center gap-2 px-4 py-2.5">
          <Search size={14} class="shrink-0 text-(--solus-text-tertiary)" />
          <Input
            bind:ref={searchEl}
            bind:value={() => flow.query, (value) => flow.setQuery(value)}
            placeholder="Search the catalog…"
            aria-label="Search the integrations catalog"
            role="combobox"
            aria-expanded={flow.results.length > 0}
            aria-controls="integration-catalog-results"
            aria-activedescendant={flow.activeIndex >= 0 ? `integration-result-${flow.activeIndex}` : undefined}
            disabled={isOffline}
            onkeydown={onSearchKeydown}
            class="h-auto min-h-7 rounded-none border-0 bg-transparent p-0 text-workspace-chrome shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        {#if flow.query.trim()}
          {#if flow.searchError}
            <div class="flex flex-wrap items-center justify-between gap-3 p-4">
              <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{flow.searchError}</p>
              <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => flow.search()}>Retry</Button>
            </div>
          {:else if flow.searching}
            {@render statusLine("Searching the catalog…")}
          {:else if flow.results.length === 0}
            <p class="p-6 text-center text-workspace-chrome text-muted-foreground">Nothing in the catalog matches “{flow.searchedQuery}”.</p>
          {:else}
            <ul id="integration-catalog-results" role="listbox" aria-label="Catalog results" class="flex flex-col py-1">
              {#each flow.results as entry, index (entry.id)}
                <li
                  id="integration-result-{index}"
                  role="option"
                  tabindex="-1"
                  aria-selected={index === flow.activeIndex}
                  class="flex cursor-pointer items-start gap-3 px-4 py-2 pointer-coarse:min-h-11 {index === flow.activeIndex ? 'bg-muted' : 'hover:bg-muted'}"
                  onpointermove={() => { flow.activeIndex = index; }}
                  onclick={() => flow.selectEntry(entry)}
                  onkeydown={(event) => { if (event.key === "Enter") flow.selectEntry(entry); }}
                >
                  {#if entry.icon}
                    <img src={entry.icon} alt="" loading="lazy" referrerpolicy="no-referrer" class="mt-0.5 size-5 shrink-0 rounded-md bg-muted object-contain" />
                  {:else}
                    <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[11px] font-medium text-muted-foreground" aria-hidden="true">{entry.name.slice(0, 1).toUpperCase()}</span>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-baseline gap-2">
                      <span class="truncate text-workspace-chrome font-medium text-foreground">{entry.name}</span>
                      <span class="shrink-0 truncate text-chrome-dense text-muted-foreground">{entry.domain}</span>
                    </div>
                    {#if entry.description}
                      <p class="line-clamp-2 text-chrome-dense text-(--solus-text-secondary)">{entry.description}</p>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
        <form class="flex flex-col gap-2 border-t border-border p-4" onsubmit={(event) => { event.preventDefault(); flow.selectCustomUrl(); }}>
          <label for="integration-custom-url" class="text-workspace-chrome font-medium text-foreground">Custom URL</label>
          <div class="flex flex-wrap items-center gap-2">
            <Input id="integration-custom-url" type="url" bind:value={flow.customUrl} placeholder="https://mcp.example.com/mcp" class="h-8 min-w-0 flex-1 text-workspace-chrome" disabled={isOffline}
              aria-invalid={flow.customUrlError ? true : undefined} aria-describedby={flow.customUrlError ? "integration-custom-url-error" : undefined} />
            <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || !flow.customUrl.trim()}>Check</Button>
          </div>
          {#if flow.customUrlError}
            <p id="integration-custom-url-error" role="alert" class="text-chrome-dense text-(--solus-status-error)">{flow.customUrlError}</p>
          {/if}
        </form>
      {/if}
    </SettingsSection>
  </div>
{/if}
