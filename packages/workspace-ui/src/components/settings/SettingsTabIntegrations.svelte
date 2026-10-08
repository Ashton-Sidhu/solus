<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["mcp", "integration", "integrations", "server", "catalog", "integrations.sh", "remote tools", "connector"];
</script>

<script lang="ts">
  /**
   * The MCP page (docs/integrations.md): the servers installed on one host, and
   * the integrations.sh catalog to add more from. Add is one step: the host
   * checks the server, adds it, and the person's sign-in starts at once.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { Check, LoaderCircle, Plus, Search, TriangleAlert, X } from "@lucide/svelte";
  import type { CatalogEntry, Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import McpServerRow from "./McpServerRow.svelte";
  import { integrationsStore } from "./integrations.store.svelte";
  import { McpCatalog } from "./lib/mcp-catalog.svelte";
  import { catalogCountText, customUrlProblem, urlHost } from "./lib/integration-labels";
  import { wordsMatch } from "./lib/settings-search";
  import { toasts } from "../../lib/toasts";

  interface Props { serverId: string; hostLabel: string; searchQuery?: string }
  let { serverId, hostLabel, searchQuery = "" }: Props = $props();

  // The page is keyed by host, so one catalog serves one host for its whole life.
  const catalog = new McpCatalog(untrack(() => serverId), untrack(() => searchQuery));
  const expanded = new SvelteSet<string>();
  let rootEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const installed = $derived(hostState?.integrations ?? []);
  const installedUrls = $derived(new Set(installed.map((integration) => integration.url)));
  const visibleInstalled = $derived(
    installed.filter((integration) => !catalog.query.trim() || wordsMatch(catalog.query, [integration.name, integration.slug, urlHost(integration.url)])),
  );
  const isOffline = $derived(!!hostState?.isDisconnected);
  /** A typed https:// address is offered as a server of its own. */
  const typedUrl = $derived(/^https?:\/\//i.test(catalog.query.trim()) ? catalog.query.trim() : "");
  const typedUrlProblem = $derived(typedUrl ? customUrlProblem(typedUrl) : null);

  $effect(() => {
    const hostId = serverId;
    return untrack(() => integrationsStore.watch(hostId));
  });
  // The settings search follows into the page's own search.
  $effect(() => {
    const query = searchQuery;
    untrack(() => catalog.setQuery(query));
  });
  // A catalog read that failed while the host was away is read again when it returns.
  $effect(() => {
    if (!isOffline) untrack(() => { if (catalog.error) void catalog.load(); });
  });
  onDestroy(() => catalog.dispose());

  function toggle(integrationId: string) {
    if (expanded.has(integrationId)) expanded.delete(integrationId);
    else expanded.add(integrationId);
  }

  async function install(name: string, url: string) {
    const integration = await catalog.install(name, url);
    if (!integration) return;
    toasts.success(`${integration.name} added`);
    expanded.add(integration.id);
    await revealRow(integration);
  }

  /** The new row opens where the person can see it, and takes focus, so its sign-in is the next step. */
  async function revealRow(integration: Integration) {
    await tick();
    const row = rootEl?.querySelector<HTMLElement>(`[data-integration-id="${CSS.escape(integration.id)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }

  /** Loads the next entries as the end of the list comes near, before the person reaches it. */
  function loadWhenNear(node: HTMLElement) {
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void catalog.loadMore();
    }, { rootMargin: "0px 0px 400px 0px" });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  async function removed(integration: Integration) {
    expanded.delete(integration.id);
    toasts.success(`${integration.name} removed`);
    await tick();
    searchEl?.focus();
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && typedUrl && !typedUrlProblem) {
      event.preventDefault();
      void install(urlHost(typedUrl), typedUrl);
    } else if (event.key === "Escape" && catalog.query) {
      event.preventDefault();
      event.stopPropagation();
      catalog.setQuery("");
    }
  }
</script>

{#snippet statusLine(text: string)}
  <p role="status" class="flex items-center justify-center gap-2 p-6 text-workspace-chrome text-muted-foreground">
    <LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />{text}
  </p>
{/snippet}

{#snippet installAction(name: string, url: string)}
  {@const state = catalog.installs.get(url)}
  {#if installedUrls.has(url)}
    <span class="flex items-center gap-1 text-workspace-chrome text-muted-foreground"><Check size={14} />Added</span>
  {:else if state?.kind === "checking" || state?.kind === "adding"}
    <span role="status" class="flex items-center gap-1.5 text-workspace-chrome text-muted-foreground">
      <LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />{state.kind === "checking" ? "Checking…" : "Adding…"}
    </span>
  {:else}
    <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline} onclick={() => install(name, url)} aria-label="Add {name}">
      <Plus size={14} />{state?.kind === "failed" ? "Retry" : "Add"}
    </Button>
  {/if}
{/snippet}

{#snippet installError(url: string)}
  {@const state = catalog.installs.get(url)}
  {#if state?.kind === "failed"}
    <div class="flex items-start gap-1.5">
      <p role="alert" class="min-w-0 flex-1 break-words text-chrome-dense text-(--solus-status-error)">{state.message}</p>
      <Button variant="ghost" size="icon-sm" class="-my-1 shrink-0 text-muted-foreground" onclick={() => catalog.dismiss(url)} aria-label="Dismiss"><X size={14} /></Button>
    </div>
  {/if}
{/snippet}

{#snippet catalogCard(entry: CatalogEntry)}
  {@const state = catalog.installs.get(entry.url)}
  <!-- Every card has the same height: a failed Add says why in the description's two lines. -->
  <li class="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5" data-testid="mcp-catalog-entry">
    <div class="flex min-w-0 items-start gap-3">
      <McpServerIcon name={entry.name} url={entry.url} icon={entry.icon} />
      <div class="min-w-0 flex-1">
        <p class="truncate text-workspace-chrome font-medium text-foreground" title={entry.name}>{entry.name}</p>
        <p class="truncate text-chrome-dense text-(--solus-text-tertiary)">{entry.domain || urlHost(entry.url)}</p>
      </div>
    </div>
    {#if state?.kind === "failed"}
      <p role="alert" class="line-clamp-2 h-[2lh] text-chrome-dense text-(--solus-status-error)" title={state.message}>{state.message}</p>
    {:else}
      <p class="line-clamp-2 h-[2lh] text-chrome-dense text-(--solus-text-secondary)" title={entry.description}>{entry.description || urlHost(entry.url)}</p>
    {/if}
    <div class="flex h-8 items-center justify-end gap-1 pointer-coarse:h-11">
      {#if state?.kind === "failed"}
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={() => catalog.dismiss(entry.url)}>Dismiss</Button>
      {/if}
      {@render installAction(entry.name, entry.url)}
    </div>
  </li>
{/snippet}

{#snippet placeholderCards(count: number)}
  {#each { length: count } as _, index (index)}
    <!-- The shape of a card, so the grid does not move when the entries arrive. -->
    <li class="flex flex-col gap-2.5 rounded-xl border border-border p-3.5" aria-hidden="true">
      <div class="flex items-start gap-3">
        <span class="size-8 shrink-0 rounded-lg bg-muted"></span>
        <div class="flex flex-1 flex-col gap-1.5 pt-0.5">
          <span class="h-3.5 w-2/5 rounded bg-muted"></span>
          <span class="h-3 w-1/4 rounded bg-muted"></span>
        </div>
      </div>
      <div class="flex h-[2lh] flex-col justify-center gap-1.5 text-chrome-dense">
        <span class="h-3 w-full rounded bg-muted"></span>
        <span class="h-3 w-3/4 rounded bg-muted"></span>
      </div>
      <div class="h-8 pointer-coarse:h-11"></div>
    </li>
  {/each}
{/snippet}

{#if !hostState || (hostState.loading && hostState.integrations === null && !hostState.isUnsupported)}
  {@render statusLine("Loading MCP servers…")}
{:else if hostState.isUnsupported}
  <SettingsHostUnsupported feature="MCP servers" {hostLabel} />
{:else}
  <div bind:this={rootEl} class="flex flex-col gap-8">
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
        <Search size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <Input
          bind:ref={searchEl}
          bind:value={() => catalog.query, (value) => catalog.setQuery(value)}
          placeholder="Search MCP servers, or paste an https:// address"
          aria-label="Search MCP servers"
          disabled={isOffline}
          onkeydown={onSearchKeydown}
          class="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-workspace-chrome shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {#if catalog.query}
          <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground" onclick={() => { catalog.setQuery(""); searchEl?.focus(); }} aria-label="Clear the search"><X size={14} /></Button>
        {/if}
      </div>
      {#if isOffline}
        <p class="flex items-center gap-2 text-workspace-chrome text-muted-foreground" role="status">
          <TriangleAlert size={14} class="shrink-0" />{hostLabel} is disconnected. This page updates when it reconnects.
        </p>
      {/if}
    </div>

    {#if typedUrl}
      <SettingsSection label="Add by address">
        <div class="flex flex-col gap-2 px-4 py-3">
          <div class="flex min-w-0 items-center gap-3">
            <McpServerIcon name={urlHost(typedUrl)} url={typedUrl} />
            <div class="min-w-0 flex-1">
              <p class="truncate text-workspace-chrome font-medium text-foreground">{urlHost(typedUrl)}</p>
              <p class="truncate text-chrome-dense text-(--solus-text-tertiary)" title={typedUrl}>{typedUrl}</p>
            </div>
            {#if !typedUrlProblem}{@render installAction(urlHost(typedUrl), typedUrl)}{/if}
          </div>
          {#if typedUrlProblem}
            <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{typedUrlProblem}</p>
          {/if}
          {@render installError(typedUrl)}
        </div>
      </SettingsSection>
    {/if}

    <SettingsSection label="Installed" description="Their tools reach every agent on {hostLabel}. Servers with sign-in use your own account.">
      {#if hostState.error}
        <div class="flex flex-wrap items-center justify-between gap-3 p-4">
          <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{hostState.error}</p>
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.load(serverId)} disabled={hostState.loading}>Retry</Button>
        </div>
      {:else if visibleInstalled.length === 0}
        <p class="p-6 text-center text-workspace-chrome text-muted-foreground">
          {installed.length === 0 ? "No MCP servers yet. Add one from the catalog below." : `No installed server matches “${catalog.query.trim()}”.`}
        </p>
      {/if}
      {#each visibleInstalled as integration (integration.id)}
        <McpServerRow
          {serverId}
          {hostLabel}
          {integration}
          isExpanded={expanded.has(integration.id)}
          onToggle={() => toggle(integration.id)}
          onRemoved={() => removed(integration)}
        />
      {/each}
    </SettingsSection>

    <SettingsSection label="Catalog" description="MCP servers from integrations.sh. Add one, then sign in if it asks." plain>
      {#snippet action()}
        <!-- The count of the last answer stays while a search runs, so the heading does not flicker. -->
        {#if !catalog.error && (!catalog.loading || catalog.entries.length > 0)}
          <span class="text-chrome-dense tabular-nums text-muted-foreground">{catalogCountText(catalog.total)}</span>
        {/if}
      {/snippet}
      {#if catalog.error}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
          <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{catalog.error}</p>
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => catalog.load()}>Retry</Button>
        </div>
      {:else if !catalog.loading && catalog.entries.length === 0}
        <p class="rounded-xl border border-dashed border-border p-6 text-center text-workspace-chrome text-muted-foreground">
          Nothing in the catalog matches “{catalog.query.trim()}”. Paste the server’s https:// address to add it.
        </p>
      {:else}
        <ul class="grid grid-cols-1 gap-3 transition-opacity motion-reduce:transition-none @min-[36rem]/pane:grid-cols-2 @min-[60rem]/pane:grid-cols-3 {catalog.loading && catalog.entries.length > 0 ? 'opacity-60' : ''}"
          aria-label="Catalog" aria-busy={catalog.loading || catalog.loadingMore}>
          {#each catalog.entries as entry (entry.id)}
            {@render catalogCard(entry)}
          {/each}
          {#if catalog.loading && catalog.entries.length === 0}
            {@render placeholderCards(6)}
          {:else if catalog.loadingMore}
            {@render placeholderCards(3)}
          {/if}
        </ul>
        {#if catalog.hasMore && !catalog.loading}
          <!-- Near the end, more load by themselves. Keyed by the count, so the
               watcher starts again after each load and keeps going while the end stays in view. -->
          {#key catalog.entries.length}
            <div class="flex justify-center" use:loadWhenNear>
              <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" disabled={catalog.loadingMore} onclick={() => catalog.loadMore()}>Show more</Button>
            </div>
          {/key}
        {/if}
      {/if}
    </SettingsSection>
  </div>
{/if}
