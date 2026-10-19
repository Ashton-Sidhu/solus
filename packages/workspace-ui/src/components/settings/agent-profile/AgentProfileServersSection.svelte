<script lang="ts">
  /**
   * Settings → Agent profile → MCP servers: each server's record (name,
   * address, how it signs in), never a credential, drawn like a server on the
   * MCP page. Adding probes the address through a host this client talks to,
   * so the record carries the auth the server asks for. The sign-in does not
   * travel with the record: a server that asks for one has no tools on a host
   * until the person connects it there. Each row says how the server stands on
   * that same host, and Connect opens the MCP page's connect dialog for it.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import { LoaderCircle, Plug, Plus, Trash2 } from "@lucide/svelte";
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import SettingsSection from "../SettingsSection.svelte";
  import McpServerIcon from "../McpServerIcon.svelte";
  import McpConnectDialog from "../McpConnectDialog.svelte";
  import { integrationsStore } from "../integrations.store.svelte";
  import { McpCatalog } from "../lib/mcp-catalog.svelte";
  import type { ConnectRequest } from "../lib/mcp-connect.svelte";
  import { customUrlProblem, probeRefusal, urlHost } from "../lib/integration-labels";
  import { toasts } from "../../../lib/toasts";
  import ProfileEntryRow from "./ProfileEntryRow.svelte";
  import ShowMoreRow from "./ShowMoreRow.svelte";
  import { authKindLabel, pageOf, integrationEntryOf, profileServerStatus, type AgentProfileSections } from "./lib/agent-profile-entries";

  interface Props {
    integrations: AgentProfileSections["integrations"];
    /** The host that probes an address and whose sign-ins the rows show; null with no host connected. */
    probeHostId: string | null;
    hostLabel: string;
  }

  let { integrations, probeHostId, hostLabel }: Props = $props();

  const hostState = $derived(probeHostId ? integrationsStore.states.get(probeHostId) : undefined);
  /** The rows show a status only when the host can say one. */
  const showsStatus = $derived(!!hostState && !hostState.isUnsupported && !hostState.error);
  const isHostOffline = $derived(!!hostState?.isDisconnected);
  let connectRequest = $state<ConnectRequest | null>(null);
  /** The connect dialog adds a server the host does not have yet through a catalog; made for one dialog. */
  let connectCatalog: McpCatalog | null = null;

  $effect(() => {
    const hostId = probeHostId;
    if (!hostId) return;
    return untrack(() => integrationsStore.watch(hostId));
  });

  onDestroy(() => connectCatalog?.dispose());

  function openConnect(request: ConnectRequest) {
    if (!probeHostId) return;
    connectCatalog?.dispose();
    connectCatalog = new McpCatalog(probeHostId);
    connectRequest = request;
  }

  function connectClosed(integrationId: string | null) {
    const name = connectRequest?.name;
    connectRequest = null;
    connectCatalog?.dispose();
    connectCatalog = null;
    if (integrationId && name) toasts.success(`${name} connected on ${hostLabel}`);
    requestInputFocus();
  }

  let isAdding = $state(false);
  let url = $state("");
  let name = $state("");
  let checking = $state(false);
  let problem = $state<string | null>(null);
  let urlEl = $state<HTMLInputElement | null>(null);
  const address = $derived(url.trim());
  const urlProblem = $derived(address ? customUrlProblem(address) : null);

  async function openAdd() {
    isAdding = true;
    await tick();
    urlEl?.focus();
  }

  function closeAdd() {
    isAdding = false;
    url = "";
    name = "";
    problem = null;
    requestInputFocus();
  }

  async function add() {
    const hostId = probeHostId;
    if (!hostId || urlProblem || checking) return;
    checking = true;
    problem = null;
    try {
      const attempt = await integrationsStore.probe(hostId, address);
      if ("error" in attempt) {
        problem = attempt.error;
        return;
      }
      const refusal = probeRefusal(attempt.result);
      if (refusal || attempt.result.outcome === "undetermined") {
        problem = refusal;
        return;
      }
      const entry = integrationEntryOf(name.trim() || urlHost(address), address, attempt.result.auth);
      if (!entry) {
        problem = "This name or address does not fit a profile entry.";
        return;
      }
      agentProfileLocalStore.setEntry(entry);
      closeAdd();
    } finally {
      checking = false;
    }
  }

  function remove(key: AgentProfileKey) {
    agentProfileLocalStore.removeKey(key);
    requestInputFocus();
  }

  let expanded = $state(false);
  const page = $derived(pageOf(integrations, expanded));

  function toggleExpanded() {
    expanded = !expanded;
    requestInputFocus();
  }
</script>

<SettingsSection
  label={integrations.length > 0 ? `MCP servers · ${integrations.length}` : "MCP servers"}
  description={showsStatus
    ? `Added for you on every host the profile reaches. Your sign-in is not part of the profile; the status is for ${hostLabel}.`
    : "Added for you on every host the profile reaches. Your sign-in is not part of the profile."}
>
  {#snippet action()}
    {#if !isAdding}
      <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" onclick={() => void openAdd()}><Plus size={14} />Add a server</Button>
    {/if}
  {/snippet}
  {#if isAdding}
    <form class="flex flex-col gap-3 px-4 py-3" onsubmit={(event) => { event.preventDefault(); void add(); }} aria-label="Add an MCP server">
      <div class="flex min-w-0 items-start gap-3">
        {#if address && !urlProblem}
          <!-- Keyed by the address, so a logo that failed for one address is tried again for the next. -->
          {#key address}<McpServerIcon name={name.trim() || urlHost(address)} url={address} />{/key}
        {:else}
          <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground" aria-hidden="true"><Plug size={14} /></span>
        {/if}
        <div class="grid min-w-0 flex-1 grid-cols-1 gap-2 @min-[30rem]/pane:grid-cols-[minmax(0,1fr)_11rem]">
          <Input
            bind:ref={urlEl}
            bind:value={url}
            placeholder="https://mcp.example.com/mcp"
            aria-label="Server address"
            autocomplete="off"
            spellcheck={false}
            class="h-8 text-workspace-chrome"
            onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeAdd(); } }}
          />
          <Input bind:value={name} placeholder={address ? urlHost(address) : "Name (optional)"} aria-label="Server name" autocomplete="off" class="h-8 text-workspace-chrome"
            onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeAdd(); } }} />
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 pl-11">
        <p class="min-w-0 flex-1 text-chrome-dense {problem || urlProblem ? 'text-(--solus-status-error)' : 'text-muted-foreground'}" role={problem ? "alert" : undefined}>
          {#if !probeHostId}
            Connect a host to check an address.
          {:else if problem}
            {problem}
          {:else if urlProblem}
            {urlProblem}
          {:else}
            Solus checks the address and how the server signs in.
          {/if}
        </p>
        <div class="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={closeAdd}>Cancel</Button>
          <Button type="submit" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={!probeHostId || !address || !!urlProblem || checking}>
            {#if checking}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Checking…{:else}Add{/if}
          </Button>
        </div>
      </div>
    </form>
  {/if}
  {#if integrations.length === 0 && !isAdding}
    <div class="flex flex-col items-center gap-1 p-8 text-center">
      <p class="text-workspace-chrome text-foreground">No MCP servers in your profile yet</p>
      <p class="text-chrome-dense text-muted-foreground">Add a server by its address. It is added on every host you work on.</p>
    </div>
  {/if}
  {#each page.rows as integration (integration.slug)}
    {@const status = showsStatus ? profileServerStatus(integration, hostState?.integrations ?? null, hostState?.connections ?? new Map()) : null}
    <ProfileEntryRow label={integration.name} detail="{urlHost(integration.url)} · {authKindLabel(integration.auth)}" testId="agent-profile-server">
      {#snippet mark()}<McpServerIcon name={integration.name} url={integration.url} />{/snippet}
      {#snippet action()}
        {#if status}
          <span class="flex max-w-48 min-w-0 items-center gap-1.5 text-chrome-dense text-(--solus-text-secondary)" title="{status.text} on {hostLabel}" data-testid="agent-profile-server-status">
            <span class="size-1.5 shrink-0 rounded-full {status.tone === 'ready' ? 'bg-(--solus-status-complete)' : status.tone === 'error' ? 'bg-(--solus-status-error)' : status.tone === 'attention' ? 'bg-(--solus-status-permission)' : 'bg-muted-foreground/50'}" aria-hidden="true"></span>
            <span class="truncate">{status.text}</span>
          </span>
          {#if status.canConnect}
            <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isHostOffline}
              onclick={() => openConnect({ name: integration.name, url: integration.url, integrationId: status.integrationId ?? undefined })}
              aria-label="Connect {integration.name} on {hostLabel}">Connect</Button>
          {/if}
        {/if}
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive pointer-coarse:size-11" onclick={() => remove(agentProfileKeyOf(integration))} aria-label="Remove {integration.name}" title="Remove">
          <Trash2 size={14} />
        </Button>
      {/snippet}
    </ProfileEntryRow>
  {/each}
  <ShowMoreRow hiddenCount={page.hiddenCount} {expanded} noun="servers" onToggle={toggleExpanded} />
</SettingsSection>

{#if connectRequest && connectCatalog && probeHostId}
  {#key connectRequest}
    <McpConnectDialog serverId={probeHostId} {hostLabel} request={connectRequest} catalog={connectCatalog} onClose={connectClosed} />
  {/key}
{/if}
