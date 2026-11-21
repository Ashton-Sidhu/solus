<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  /**
   * The MCP page (docs/integrations.md): the servers installed on one host, and
   * the integrations.sh catalog to connect more from, filtered by a rail of
   * categories (a row of chips in a narrow page). Connect opens one dialog that
   * adds the server, signs the person in, and asks which tools agents may use.
   * Add command opens the same dialog on a command's form
   * (docs/plans/mcp-first-class.md §7.7), as does the palette's "Add an MCP
   * server command". While the page is open it holds the host's running-servers
   * lease, so the host looks for MCP servers on its loopback and follows the
   * loopback servers it has (§9.1); no page, no scan.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { Check, FileSearch, LayoutGrid, LoaderCircle, Plus, RefreshCw, Search, TriangleAlert, X } from "@lucide/svelte";
  import { CATALOG_CATEGORIES, type CatalogCategoryId, type CatalogEntry, type FoundServer, type Integration } from "@solus/contracts/integration-types";
  import { NO_FOUND_SERVERS_TEXT, configFileLabel, foundSectionText, portScanUnavailableText } from "@solus/contracts/integrations/found-server-labels";
  import { hostPathBaseName } from "@solus/contracts/host-path";
  import { projectScopeOf } from "@solus/contracts/types";
  import { isChat } from "@solus/contracts/chat";
  import { getWorkspaceContext } from "../../contexts";
  import { runningServers } from "../../contexts/running-servers/running-servers.store.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import McpConnectDialog from "./McpConnectDialog.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import McpServerRow from "./McpServerRow.svelte";
  import McpFoundRow from "./McpFoundRow.svelte";
  import McpFoundDialog from "./McpFoundDialog.svelte";
  import { McpFound, mcpStore } from "../../contexts/mcp";
  import { mcpPageRequest } from "./lib/mcp-page-request.svelte";
  import { McpCatalog } from "./lib/mcp-catalog.svelte";
  import type { ConnectRequest } from "./lib/mcp-connect.svelte";
  import { catalogCountText, customUrlProblem, IntegrationLabels, urlHost } from "./lib/integration-labels";
  import { wordsMatch } from "./lib/settings-search";
  import { toasts } from "../../lib/toasts";
  import solusIcon from "../../../../../resources/icon.iconset/icon_32x32@2x.png";

  interface Props { serverId: string; hostLabel: string; searchQuery?: string }
  let { serverId, hostLabel, searchQuery = "" }: Props = $props();

  /** What the page lists: everything, the installed servers alone, the servers in the host's config files, or one catalog category. */
  type McpView = "all" | "installed" | "found" | CatalogCategoryId;

  // The page is keyed by host, so one catalog serves one host for its whole life.
  const catalog = new McpCatalog(untrack(() => serverId), untrack(() => searchQuery));
  const expanded = new SvelteSet<string>();
  let view = $state<McpView>("all");
  let connectRequest = $state<ConnectRequest | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  /** The found servers, read when the person first opens their view. */
  let found = $state<McpFound | null>(null);
  let reviewing = $state<FoundServer | null>(null);
  let addError = $state("");
  const workspace = getWorkspaceContext();
  /** The project of the open session, when it is on this host: its files are read too (§8.1). */
  const sessionScope = $derived(workspace.serverIdForContext(workspace.ctx) === serverId ? projectScopeOf(workspace.ctx.session) : null);
  // A chat has no project (docs/plans/projectless-chat.md): only the host's own files are read then.
  const projectPath = $derived(sessionScope && !isChat(sessionScope) ? sessionScope : null);
  const projectName = $derived(projectPath ? hostPathBaseName(projectPath) || projectPath : null);

  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const hostServers = $derived(runningServers.forHost(serverId));
  const installed = $derived(hostState?.integrations ?? []);
  const installedByUrl = $derived(new Map(installed.map((integration) => [integration.url, integration])));
  const visibleInstalled = $derived(
    installed.filter((integration) => !catalog.query.trim() || wordsMatch(catalog.query, [integration.name, integration.slug, urlHost(integration.url), integration.launch?.command ?? ""])),
  );
  const isOffline = $derived(!!hostState?.isDisconnected);
  /** A typed https:// address is offered as a server of its own. */
  const typedUrl = $derived(/^https?:\/\//i.test(catalog.query.trim()) ? catalog.query.trim() : "");
  const typedUrlProblem = $derived(typedUrl ? customUrlProblem(typedUrl) : null);
  const viewCategory = $derived(CATALOG_CATEGORIES.find((category) => category.id === view) ?? null);

  $effect(() => {
    const hostId = serverId;
    return untrack(() => mcpStore.integrations.watch(hostId));
  });
  // The palette asked for the command form: it opens once the page shows.
  $effect(() => {
    if (mcpPageRequest.isAddCommandAsked && hostState?.integrations) untrack(() => { if (mcpPageRequest.takeAddCommand()) addCommand(); });
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
  // Reading the list holds the lease while the page is open. A changed list can start or stop an MCP server on the loopback: the found view reads again.
  $effect(() => {
    void hostServers.servers;
    untrack(() => { if (found && !found.loading) void found.load(); });
  });
  // The command palette asks for the found servers ("Find MCP servers on this host").
  $effect(() => {
    if (mcpPageRequest.view !== "found") return;
    untrack(() => { mcpPageRequest.view = null; showView("found"); });
  });
  onDestroy(() => { catalog.dispose(); found?.dispose(); });

  function showView(next: McpView) {
    view = next;
    if (next === "found") {
      // Read once for the page's project; Refresh reads the files again.
      found ??= new McpFound(serverId, projectPath);
      return;
    }
    if (next !== "installed") catalog.setCategory(next === "all" ? null : next);
  }

  function addCommand() {
    connectRequest = { name: "", url: "", isCommand: true };
  }

  async function confirmFound(useFileValues: boolean) {
    if (!found || !reviewing) return;
    const server = reviewing;
    addError = "";
    const result = await found.add(server, useFileValues);
    if (result.kind === "failed") { addError = result.message; return; }
    reviewing = null;
    if (result.kind === "found-changed") {
      toasts.error(`${server.name} changed in its file. Read it again before you add it.`);
      return;
    }
    if (result.needsValues) {
      // A command cannot start without its values: its row opens the values form (§7.6).
      toasts.success(`${server.name} added. Enter its values to start it.`);
      showView("installed");
      expanded.add(result.integration.id);
      await mcpStore.integrations.connect(serverId, result.integration.id);
      await revealRow(result.integration, false);
      return;
    }
    toasts.success(server.transport?.kind === "stdio" ? `${server.name} added. Start it from Installed.` : `${server.name} added`);
  }

  async function foundDialogClosed() {
    reviewing = null;
    addError = "";
    await tick();
    searchEl?.focus();
  }

  function toggle(integrationId: string) {
    if (expanded.has(integrationId)) expanded.delete(integrationId);
    else expanded.add(integrationId);
  }

  /** True when the person can use the server's tools now: no sign-in, or signed in. */
  function isReady(integration: Integration): boolean {
    return new IntegrationLabels(integration).canListTools(hostState?.connections.get(integration.id) ?? null);
  }

  async function connectClosed(integrationId: string | null) {
    connectRequest = null;
    const integration = integrationId ? installed.find((item) => item.id === integrationId) : null;
    if (integration) {
      toasts.success(`${integration.name} connected`);
      await revealRow(integration);
      return;
    }
    await tick();
    searchEl?.focus();
  }

  /** The row shows where the person can see it, and takes focus unless a form in it holds the focus already. */
  async function revealRow(integration: Integration, takesFocus = true) {
    await tick();
    const row = rootEl?.querySelector<HTMLElement>(`[data-integration-id="${CSS.escape(integration.id)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (takesFocus) row?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
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
      connectRequest = { name: urlHost(typedUrl), url: typedUrl, integrationId: installedByUrl.get(typedUrl)?.id };
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

{#snippet viewButton(target: McpView, label: string, layout: "rail" | "chip")}
  {@const isCurrent = view === target}
  <!-- The chip matches the settings page's own chips. -->
  <button
    type="button"
    class="flex shrink-0 items-center overflow-hidden text-left text-workspace-chrome outline-none focus-visible:ring-2 focus-visible:ring-ring {layout === 'rail'
      ? `min-h-8 w-full gap-2 rounded-lg px-2.5 pointer-coarse:min-h-11 ${isCurrent ? 'bg-muted text-foreground' : 'text-(--solus-text-secondary) hover:bg-muted/60 hover:text-foreground'}`
      : `h-6.5 gap-1.5 rounded-full px-2.5 transition-colors [-webkit-tap-highlight-color:transparent] pointer-coarse:h-8 ${isCurrent
        ? 'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
        : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground active:bg-[var(--wash-1)]'}`}"
    aria-current={isCurrent ? "page" : undefined}
    onclick={() => showView(target)}
  >
    {#if layout === "rail" && target === "all"}<LayoutGrid size={16} class="shrink-0" />{/if}
    {#if layout === "rail" && target === "installed"}<Check size={16} class="shrink-0" />{/if}
    {#if layout === "rail" && target === "found"}<FileSearch size={16} class="shrink-0" />{/if}
    <span class="truncate">{label}</span>
    {#if target === "installed" && installed.length > 0}
      <span class="shrink-0 text-chrome-dense tabular-nums text-muted-foreground {layout === 'rail' ? 'ml-auto pl-1' : 'opacity-60'}">{installed.length}</span>
    {/if}
  </button>
{/snippet}

{#snippet entryAction(name: string, url: string, icon: string | undefined, authHelp: string | undefined)}
  {@const integration = installedByUrl.get(url)}
  {#if integration && isReady(integration)}
    <!-- The same box as the small Connect button beside it, so the column's edge stays even. -->
    <span class="flex h-7 shrink-0 items-center px-2.5 pointer-coarse:min-h-11" title="Connected"><Check size={16} strokeWidth={2.5} class="text-(--solus-status-complete)" aria-hidden="true" /><span class="sr-only">Connected</span></span>
  {:else}
    <Button variant="outline" size="sm" class="shrink-0 border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isOffline}
      onclick={() => { connectRequest = { name: integration?.name ?? name, url, icon, integrationId: integration?.id, authHelp }; }} aria-label="Connect {name}">Connect</Button>
  {/if}
{/snippet}

{#snippet catalogRow(entry: CatalogEntry)}
  <li class="flex min-w-0 items-center gap-3.5 py-3" data-testid="mcp-catalog-entry">
    <McpServerIcon name={entry.name} url={entry.url} icon={entry.icon} />
    <div class="min-w-0 flex-1 pr-6">
      <p class="flex min-w-0 items-center gap-1.5 text-workspace-chrome leading-5 font-medium text-foreground" title={entry.name}>
        <span class="truncate">{entry.name}</span>
        {#if entry.source === "solus"}
          <!-- Listed by Solus, not the integrations.sh feed (§13.5). -->
          <img src={solusIcon} alt="Solus" title="Listed by Solus" class="size-[19px] shrink-0 object-contain" />
        {/if}
      </p>
      <p class="truncate text-chrome-dense leading-5 text-muted-foreground" title={entry.description}>{entry.description || entry.domain || urlHost(entry.url)}</p>
    </div>
    {@render entryAction(entry.name, entry.url, entry.icon, entry.authHelp)}
  </li>
{/snippet}

{#snippet placeholderRows(count: number)}
  {#each { length: count } as _, index (index)}
    <!-- The shape of a row, so the list does not move when the entries arrive. -->
    <li class="flex items-center gap-3.5 py-3" aria-hidden="true">
      <span class="size-8 shrink-0 rounded-lg bg-muted"></span>
      <div class="flex flex-1 flex-col gap-1.5">
        <span class="h-3.5 w-2/5 rounded bg-muted"></span>
        <span class="h-3 w-3/4 rounded bg-muted"></span>
      </div>
      <span class="h-8 w-20 shrink-0 rounded-lg bg-muted"></span>
    </li>
  {/each}
{/snippet}

{#snippet installedSection()}
  <SettingsSection {...settingsDefinitions["mcp.section-installed"]} description="Their tools reach every agent on {hostLabel}. Servers with sign-in use your own account.">
    {#snippet action()}
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline} onclick={addCommand}><Plus size={14} />Add command</Button>
    {/snippet}
    {#if hostState?.error}
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{hostState.error}</p>
        <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => mcpStore.integrations.load(serverId)} disabled={hostState.loading}>Retry</Button>
      </div>
    {:else if visibleInstalled.length === 0}
      <p class="p-6 text-center text-workspace-chrome text-muted-foreground">
        {installed.length === 0 ? "No MCP servers yet. Connect one from the catalog, or add a command that runs on this host." : `No installed server matches “${catalog.query.trim()}”.`}
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
        onConnect={() => { connectRequest = { name: integration.name, url: integration.url, integrationId: integration.id }; }}
      />
    {/each}
  </SettingsSection>
{/snippet}

{#snippet foundSection()}
  <SettingsSection {...settingsDefinitions["mcp.section-found"]} description={foundSectionText(hostLabel, projectName)}>
    {#snippet action()}
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || !found || found.loading || found.refreshing} onclick={() => found?.load(true)}>
        <RefreshCw size={14} class={found?.refreshing ? "animate-spin motion-reduce:animate-none" : ""} />Refresh
      </Button>
    {/snippet}
    {#if !found || found.loading}
      <ul class="px-4" aria-busy="true" aria-label="Found servers">{@render placeholderRows(3)}</ul>
    {:else if found.isUnsupported}
      <p class="p-6 text-center text-workspace-chrome text-muted-foreground">{hostLabel} is older than this view. Update Solus on it to find its MCP servers.</p>
    {:else if found.error}
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{found.error}</p>
        <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => found?.load(true)}>Retry</Button>
      </div>
    {:else}
      {#if found.servers.length === 0}
        <p class="p-6 text-center text-workspace-chrome text-muted-foreground">{NO_FOUND_SERVERS_TEXT}</p>
      {/if}
      {#each found.servers as server (server.foundId)}
        <McpFoundRow {server} {projectName} {hostLabel} {isOffline} isAdding={found.adding === server.foundId} onReview={(next) => { addError = ""; reviewing = next; }} />
      {/each}
      {#if found.portScan?.state === "unavailable"}
        <p class="flex items-start gap-2 px-4 py-3 text-chrome-dense text-(--solus-text-secondary)">
          <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{portScanUnavailableText(found.portScan.reason)}
        </p>
      {/if}
      {#each found.problems as file (file.path)}
        <p class="flex items-start gap-2 px-4 py-3 text-chrome-dense text-(--solus-text-secondary)">
          <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{configFileLabel(file.file)} ({file.path}) was not read. {file.problem}
        </p>
      {/each}
    {/if}
  </SettingsSection>
{/snippet}

{#snippet catalogSection()}
  <!-- A catalog group is headed by a small muted label, not a settings heading:
       the rows are the content, and the label only names the group. -->
  <section class="flex flex-col gap-1" aria-labelledby="mcp-catalog-label">
    <div class="flex items-baseline justify-between gap-4">
      <h2 id="mcp-catalog-label" class="text-chrome-dense font-medium text-muted-foreground">{viewCategory?.label ?? (catalog.query.trim() ? "Catalog" : "Popular")}</h2>
      <!-- The count of the last answer stays while a search runs, so the heading does not flicker. -->
      {#if !catalog.error && (!catalog.loading || catalog.entries.length > 0)}
        <span class="text-chrome-dense tabular-nums text-muted-foreground">{catalogCountText(catalog.total)}</span>
      {/if}
    </div>
    {#if catalog.error}
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
        <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{catalog.error}</p>
        <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => catalog.load()}>Retry</Button>
      </div>
    {:else if !catalog.loading && catalog.entries.length === 0}
      <p class="rounded-xl border border-dashed border-border p-6 text-center text-workspace-chrome text-muted-foreground">
        {catalog.query.trim()
          ? `Nothing in the catalog matches “${catalog.query.trim()}”. Paste the server’s https:// address to connect it.`
          : "No server in the catalog is in this category yet."}
      </p>
    {:else}
      <ul class="grid grid-cols-1 gap-x-14 transition-opacity motion-reduce:transition-none @min-[56rem]/mcp:grid-cols-2 {catalog.loading && catalog.entries.length > 0 ? 'opacity-60' : ''}"
        aria-label="Catalog" aria-busy={catalog.loading || catalog.loadingMore}>
        {#each catalog.entries as entry (entry.id)}
          {@render catalogRow(entry)}
        {/each}
        {#if catalog.loading && catalog.entries.length === 0}
          {@render placeholderRows(8)}
        {:else if catalog.loadingMore}
          {@render placeholderRows(4)}
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
    <p class="pt-3 text-chrome-dense text-muted-foreground">Servers come from the integrations.sh catalog.</p>
  </section>
{/snippet}

{#if !hostState || (hostState.loading && hostState.integrations === null && !hostState.isUnsupported)}
  {@render statusLine("Loading MCP servers…")}
{:else if hostState.isUnsupported}
  <SettingsHostUnsupported feature="MCP servers" {hostLabel} />
{:else}
  <div bind:this={rootEl} class="@container/mcp flex flex-col gap-6">
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

    <!-- The chips replace the rail in a narrow page, at the same width. They
         wrap, as the settings chips do, so every view shows without a swipe. -->
    <nav class="flex flex-wrap gap-1.5 @min-[44rem]/mcp:hidden" aria-label="MCP views">
      {@render viewButton("all", "All", "chip")}
      {@render viewButton("installed", "Installed", "chip")}
      {@render viewButton("found", "Found on this host", "chip")}
      {#each CATALOG_CATEGORIES as category (category.id)}
        {@render viewButton(category.id, category.label, "chip")}
      {/each}
    </nav>

    <div class="grid grid-cols-1 gap-8 @min-[44rem]/mcp:grid-cols-[11rem_minmax(0,1fr)]">
      <nav class="hidden flex-col gap-0.5 self-start @min-[44rem]/mcp:sticky @min-[44rem]/mcp:top-16 @min-[44rem]/mcp:flex" aria-label="MCP views">
        {@render viewButton("all", "All", "rail")}
        {@render viewButton("installed", "Installed", "rail")}
        {@render viewButton("found", "Found on this host", "rail")}
        <p class="mt-5 mb-1.5 px-2.5 text-chrome-dense text-muted-foreground">Categories</p>
        {#each CATALOG_CATEGORIES as category (category.id)}
          {@render viewButton(category.id, category.label, "rail")}
        {/each}
      </nav>

      <div class="flex min-w-0 flex-col gap-8">
        {#if typedUrl}
          <SettingsSection {...settingsDefinitions["mcp.section-connect-by-address"]}>
            <div class="flex flex-col gap-2 px-4 py-3">
              <div class="flex min-w-0 items-center gap-3">
                <McpServerIcon name={urlHost(typedUrl)} url={typedUrl} />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-workspace-chrome font-medium text-foreground">{urlHost(typedUrl)}</p>
                  <p class="truncate text-chrome-dense text-(--solus-text-tertiary)" title={typedUrl}>{typedUrl}</p>
                </div>
                {#if !typedUrlProblem}{@render entryAction(urlHost(typedUrl), typedUrl, undefined, undefined)}{/if}
              </div>
              {#if typedUrlProblem}
                <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{typedUrlProblem}</p>
              {/if}
            </div>
          </SettingsSection>
        {/if}

        {#if view === "all" || view === "installed"}
          {@render installedSection()}
        {/if}
        {#if view === "found"}
          {@render foundSection()}
        {:else if view !== "installed"}
          {@render catalogSection()}
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if reviewing && found}
  {#key reviewing.foundId}
    <McpFoundDialog server={reviewing} current={installed.find((integration) => integration.id === reviewing?.integrationId) ?? null} {projectName} {hostLabel}
      isAdding={found.adding === reviewing.foundId} error={addError} onConfirm={confirmFound} onClose={foundDialogClosed} />
  {/key}
{/if}

{#if connectRequest}
  {#key connectRequest}
    <McpConnectDialog {serverId} {hostLabel} request={connectRequest} {catalog} onClose={connectClosed} />
  {/key}
{/if}
