<script lang="ts">
  /**
   * One installed MCP server on the MCP page: its state in a few words and the
   * one action that changes it, with its account, OAuth client, and tools one step
   * down, and Rename and Remove in its menu. A sign-in that runs keeps the row open, so the person
   * always sees where it stands.
   */
  import { ChevronRight, Ellipsis, LoaderCircle } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Popover from "../ui/popover";
  import IntegrationConnectForm from "./IntegrationConnectForm.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import IntegrationOAuthClientForm from "./IntegrationOAuthClientForm.svelte";
  import { integrationsStore } from "./integrations.store.svelte";
  import { canListTools, firstLine, integrationStatusText, urlHost } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    hostLabel: string;
    integration: Integration;
    isExpanded: boolean;
    onToggle: () => void;
    onRemoved: () => void;
  }

  let { serverId, hostLabel, integration, isExpanded, onToggle, onRemoved }: Props = $props();

  let isRenaming = $state(false);
  let renameDraft = $state("");
  let isConfirmingRemove = $state(false);
  let menuTriggerEl = $state<HTMLElement | null>(null);
  let removeButtonEl = $state<HTMLElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const connection = $derived(hostState?.connections.get(integration.id) ?? null);
  const flow = $derived(hostState?.connectFlows.get(integration.id) ?? null);
  const status = $derived(integrationStatusText(integration.auth, connection));
  const toolsListable = $derived(canListTools(integration.auth, connection));
  const isBusy = $derived(!!hostState?.saving);
  const isOffline = $derived(!!hostState?.isDisconnected);
  // A running sign-in shows in the body, so the row stays open while it runs.
  const isOpen = $derived(isExpanded || (!!flow && flow.kind !== "failed"));
  const showConnect = $derived(status.canConnect && !isOpen && hostState?.connectionsStatus === "loaded");
  const needsOAuthClient = $derived(integration.auth.kind === "oauth" && integration.auth.registration === "client-required");

  // Tools load once the row is open and the host can list them; never for a server the person has not connected.
  $effect(() => {
    if (isOpen && toolsListable && !hostState?.tools.has(integration.id) && !hostState?.toolErrors.has(integration.id)) {
      void integrationsStore.loadTools(serverId, integration.id);
    }
  });

  function startRename() {
    if (!isOpen) onToggle();
    isRenaming = true;
    renameDraft = integration.name;
  }

  async function saveRename() {
    const name = renameDraft.trim();
    if (!name || name === integration.name) { isRenaming = false; return; }
    if (await integrationsStore.update(serverId, { id: integration.id, name })) isRenaming = false;
  }

  /** The confirm opens beside the menu button once the menu has closed and handed focus back. */
  function startRemove() {
    isRenaming = false;
    integrationsStore.clearWriteError(serverId);
    requestAnimationFrame(() => { isConfirmingRemove = true; });
  }

  async function remove() {
    if (await integrationsStore.remove(serverId, integration.id)) {
      isConfirmingRemove = false;
      onRemoved();
    }
  }
</script>

{#snippet field(label: string, content: Snippet)}
  <div class="grid grid-cols-1 gap-1.5 py-3 @min-[30rem]/pane:grid-cols-[7rem_minmax(0,1fr)] @min-[30rem]/pane:gap-4">
    <p class="text-workspace-chrome leading-8 text-(--solus-text-secondary)">{label}</p>
    <div class="flex min-h-8 min-w-0 flex-col justify-center">{@render content()}</div>
  </div>
{/snippet}

{#snippet account()}
  <IntegrationConnectForm {serverId} integrationId={integration.id} integrationName={integration.name} />
{/snippet}

{#snippet oauthClient()}
  <IntegrationOAuthClientForm {serverId} {integration} />
{/snippet}

{#snippet tools()}
  {@const list = hostState?.tools.get(integration.id)}
  {@const toolError = hostState?.toolErrors.get(integration.id)}
  {#if !toolsListable}
    <p class="text-workspace-chrome text-muted-foreground">Connect to see its tools.</p>
  {:else if toolError}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{toolError}</p>
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.loadTools(serverId, integration.id)}>Retry</Button>
    </div>
  {:else if !list}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Loading tools…</p>
  {:else if list.length === 0}
    <p class="text-workspace-chrome text-muted-foreground">This server lists no tools.</p>
  {:else}
    <ul class="flex max-h-80 flex-col gap-3 overflow-y-auto" aria-label="Tools of {integration.name}">
      {#each list as tool (tool.name)}
        <li class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-workspace-chrome text-foreground">{tool.title || tool.name}</span>
            {#if tool.destructive}
              <span class="shrink-0 text-chrome-dense text-destructive">Destructive</span>
            {:else if tool.readOnly}
              <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">Read-only</span>
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

<div class="px-4 py-3" data-testid="integration-row" data-integration-id={integration.id}>
  <div class="flex min-w-0 items-center gap-3">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      aria-expanded={isOpen}
      aria-label="{integration.name}, {status.text}"
      onclick={onToggle}
    >
      <McpServerIcon name={integration.name} url={integration.url} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-workspace-chrome font-medium text-foreground">{integration.name}</span>
        <span class="truncate text-chrome-dense text-(--solus-text-tertiary)">{urlHost(integration.url)}</span>
      </span>
      {#if !showConnect && !isOpen}
        <span class="max-w-[40%] shrink-0 truncate text-chrome-dense {status.tone === 'error' ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">{status.text}</span>
      {/if}
    </button>
    {#if showConnect}
      <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline}
        onclick={() => integrationsStore.connect(serverId, integration.id)} aria-label="{connection ? 'Reconnect' : 'Connect'} {integration.name}">{connection ? "Reconnect" : "Connect"}</Button>
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} bind:ref={menuTriggerEl} variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" disabled={isBusy || isOffline} aria-label="More actions for {integration.name}">
            <Ellipsis size={16} />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-40">
        <DropdownMenu.Item onSelect={startRename}>Rename</DropdownMenu.Item>
        <DropdownMenu.Item variant="destructive" onSelect={startRemove}>Remove…</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <Popover.Root bind:open={isConfirmingRemove}>
      <Popover.Content customAnchor={menuTriggerEl} side="bottom" align="end" sideOffset={6} collisionPadding={8}
        class="w-[min(18rem,calc(100vw-2rem))] gap-3 p-3.5 text-workspace-chrome lg:text-workspace-chrome" aria-label="Remove {integration.name}"
        onOpenAutoFocus={(event) => { event.preventDefault(); removeButtonEl?.focus(); }}>
        <div class="flex flex-col gap-1">
          <p class="font-medium text-foreground">Remove {integration.name}?</p>
          <p class="text-pretty text-(--solus-text-secondary)">Agents on {hostLabel} lose its tools. You can add it again from the catalog.</p>
        </div>
        {#if hostState?.writeError}
          <p role="alert" class="break-words text-(--solus-status-error)">{hostState.writeError}</p>
        {/if}
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { isConfirmingRemove = false; }} disabled={isBusy}>Cancel</Button>
          <Button bind:ref={removeButtonEl} variant="destructive" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={remove} disabled={isBusy}>{isBusy ? "Removing…" : "Remove"}</Button>
        </div>
      </Popover.Content>
    </Popover.Root>
    <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" onclick={onToggle} aria-label="{isOpen ? 'Hide' : 'Show'} the details of {integration.name}" aria-expanded={isOpen}>
      <ChevronRight size={16} class="transition-transform motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" />
    </Button>
  </div>

  {#if isOpen}
    <div class="mt-3 flex flex-col divide-y divide-border border-t border-border">
      {#if isRenaming}
        <form class="flex flex-wrap items-center gap-2 py-3" onsubmit={(event) => { event.preventDefault(); void saveRename(); }}>
          <!-- svelte-ignore a11y_autofocus -->
          <Input bind:value={renameDraft} aria-label="Name of {integration.name}" class="h-8 min-w-0 flex-1 text-workspace-chrome" autofocus
            onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); isRenaming = false; } }} />
          <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { isRenaming = false; }}>Cancel</Button>
          <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || !renameDraft.trim()}>{isBusy ? "Saving…" : "Save"}</Button>
        </form>
      {/if}
      {#if isRenaming && hostState?.writeError}
        <p role="alert" class="break-words py-3 text-workspace-chrome text-(--solus-status-error)">{hostState.writeError}</p>
      {/if}
      {#if needsOAuthClient}
        {@render field("OAuth client", oauthClient)}
      {/if}
      {#if integration.auth.kind !== "none"}
        {@render field("Account", account)}
      {/if}
      {@render field("Tools", tools)}
    </div>
  {/if}
</div>
