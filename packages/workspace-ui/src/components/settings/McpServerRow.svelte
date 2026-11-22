<script lang="ts">
  /**
   * One installed MCP server on the MCP page: its state in a few words and the
   * one action that changes it, with its account, OAuth client, and tools one step
   * down, and Rename and Remove in its menu. Connect opens the connect dialog.
   * Each tool's switch saves at once, so a tool can be turned off after the sign-in too.
   * A command (docs/plans/mcp-first-class.md §7.7) shows its line and its
   * process state instead of an address, its process actions, its values in
   * place of an account, and Edit for its line, folder, and names. Only a
   * person with `host.admin` edits or starts one; the row says why to others.
   * A server on the host's loopback says Not running when nothing listens on
   * its port (§9.3), in a neutral color, and lists its tools when it runs again.
   * Its menu turns all its tools off or on, and, for a server that came from
   * another tool's config file, opens that file or deletes the entry there
   * (§8.8). A server with every tool off says Off.
   */
  import { ChevronRight, Ellipsis, LoaderCircle, Pencil, SquareTerminal, ToggleLeft, ToggleRight, Trash2 } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type { FoundPlace, FoundServer, Integration, IntegrationFoundChange } from "@solus/contracts/integration-types";
  import { COMMAND_ADMIN_ONLY, commandLineText } from "@solus/contracts/integrations/command-server";
  import { NOT_RUNNING_LABEL, foundDeleteQuestion, notRunningText, projectOnlyLabel, type FoundFileAction } from "@solus/contracts/integrations/found-server-labels";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Popover from "../ui/popover";
  import IntegrationConnectForm from "./IntegrationConnectForm.svelte";
  import IntegrationExtraAccounts from "./IntegrationExtraAccounts.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import McpConfirmPopover from "./McpConfirmPopover.svelte";
  import McpFoundFileItems from "./McpFoundFileItems.svelte";
  import McpCliSkipNote from "./McpCliSkipNote.svelte";
  import McpToolSwitches from "./McpToolSwitches.svelte";
  import IntegrationOAuthClientForm from "./IntegrationOAuthClientForm.svelte";
  import McpCommandFields from "./McpCommandFields.svelte";
  import McpCommandProcess from "./McpCommandProcess.svelte";
  import McpAuthWordsField from "./McpAuthWordsField.svelte";
  import { McpCommandForm } from "./lib/mcp-command.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import { hosts } from "../../contexts";
  import { IntegrationLabels, urlHost } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    hostLabel: string;
    integration: Integration;
    isExpanded: boolean;
    onToggle: () => void;
    onRemoved: () => void;
    onConnect: () => void;
    /** The entry of another tool's config file this server came from, when the host found one. */
    found: FoundServer | null;
    canOpenFiles: boolean;
    isChangingFile: boolean;
    onOpenFile: (place: FoundPlace) => void;
    /** The error's words, or null when the file changed. */
    onFileChange: (server: FoundServer, place: FoundPlace, change: IntegrationFoundChange) => Promise<string | null>;
  }

  let { serverId, hostLabel, integration, isExpanded, onToggle, onRemoved, onConnect, found, canOpenFiles, isChangingFile, onOpenFile, onFileChange }: Props = $props();
  let fileDelete = $state<FoundFileAction | null>(null);
  let isConfirmingFileDelete = $state(false);
  let fileError = $state("");

  let isRenaming = $state(false);
  let renameDraft = $state("");
  let isConfirmingRemove = $state(false);
  let menuTriggerEl = $state<HTMLElement | null>(null);
  let removeButtonEl = $state<HTMLElement | null>(null);
  /** The open editor of a command's line, folder, and names. */
  let commandEditor = $state<McpCommandForm | null>(null);

  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const connection = $derived(hostState?.connections.get(integration.id) ?? null);
  const flow = $derived(hostState?.connectFlows.get(integration.id) ?? null);
  const labels = $derived(new IntegrationLabels(integration));
  const status = $derived(labels.statusText(connection));
  const toolsListable = $derived(labels.canListTools(connection));
  const isBusy = $derived(!!hostState?.saving);
  const isOffline = $derived(!!hostState?.isDisconnected);
  // A running sign-in shows in the body, so the row stays open while it runs.
  const isOpen = $derived(isExpanded || (!!flow && flow.kind !== "failed"));
  const showConnect = $derived(status.canConnect && !isOpen && hostState?.connectionsStatus === "loaded");
  const offersOAuthClientSetup = $derived(integration.auth.kind === "oauth");
  const disabledTools = $derived(new Set(integration.disabledTools));
  const toolList = $derived(hostState?.tools.get(integration.id));
  /** Every tool is off, as far as the listed tools show: agents get nothing from it. */
  const isOff = $derived(!!toolList?.length && toolList.every((tool) => disabledTools.has(tool.name)));
  const cliSkips = $derived(hostState?.facts.get(integration.id)?.cliSkips ?? []);
  const isNotRunning = $derived(!!hostState?.processes.isNotRunning(integration));
  // An integration is personal: only its owner changes it (docs/plans/access-model.md §2.7).
  const canEdit = $derived(hosts.get(serverId)?.me.may("edit", { kind: "integration", id: integration.id, role: integration.role }) ?? true);
  const isCommand = $derived(integration.kind === "stdio");
  /** A command or a `headers` server: the person's values stand in for a sign-in (docs/plans/mcp-add-server.md). */
  const takesValues = $derived(labels.valueNames.length > 0);
  // A command runs as code on the host: only `host.admin` changes or starts it (§7.2).
  const mayRunCommands = $derived(hosts.get(serverId)?.me.may("host.admin") ?? true);
  const processStatus = $derived(hostState?.processes.statusOf(integration, connection, mayRunCommands) ?? null);
  /** The row's short state: a command's process, or that a loopback server does not run, else the sign-in. */
  const rowStatus = $derived(isOff
    ? { text: "Off", isError: false }
    : processStatus && (status.tone === "ready" || !status.canConnect)
    ? { text: processStatus.label, isError: processStatus.tone === "error" }
    : isNotRunning && (status.tone === "ready" || !status.canConnect)
      ? { text: NOT_RUNNING_LABEL, isError: false }
      : { text: status.text, isError: status.tone === "error" });
  const subtitle = $derived(integration.launch ? commandLineText(integration.launch) : urlHost(integration.url));

  function setTool(toolName: string, isOn: boolean) {
    if (!canEdit) return;
    const next = new Set(integration.disabledTools);
    if (isOn) next.delete(toolName);
    else next.add(toolName);
    void mcpStore.integrations.update(serverId, { id: integration.id, disabledTools: [...next] });
  }

  /** Turns every listed tool off, or all of them on. A tool the server adds later is on. */
  async function setAllTools(isOn: boolean) {
    if (!canEdit) return;
    if (isOn) {
      void mcpStore.integrations.update(serverId, { id: integration.id, disabledTools: [] });
      return;
    }
    if (!hostState?.tools.has(integration.id)) await mcpStore.integrations.loadTools(serverId, integration.id);
    const names = mcpStore.integrations.states.get(serverId)?.tools.get(integration.id)?.map((tool) => tool.name) ?? [];
    if (names.length) void mcpStore.integrations.update(serverId, { id: integration.id, disabledTools: names });
  }

  /** A delete from another tool's file asks first, once the menu has closed. */
  function startFileDelete(action: FoundFileAction) {
    fileError = "";
    fileDelete = action;
    requestAnimationFrame(() => { isConfirmingFileDelete = true; });
  }

  async function confirmFileDelete() {
    if (!found || !fileDelete) return;
    const error = await onFileChange(found, fileDelete.place, "delete");
    if (error) fileError = error;
    else isConfirmingFileDelete = false;
  }

  // Tools load once the row is open and the host can list them; never for a server the person has not connected, or one that does not run.
  $effect(() => {
    if (isOpen && toolsListable && !isNotRunning && !hostState?.tools.has(integration.id) && !hostState?.toolErrors.has(integration.id)) {
      void mcpStore.integrations.loadTools(serverId, integration.id);
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
    if (await mcpStore.integrations.update(serverId, { id: integration.id, name })) isRenaming = false;
  }

  /** A command or a `headers` server without values asks for them in place: there is no sign-in page. */
  function enterValues() {
    if (!isOpen) onToggle();
    void mcpStore.integrations.connect(serverId, integration.id);
  }

  function editCommand() {
    if (!isOpen) onToggle();
    commandEditor = new McpCommandForm(serverId, () => mayRunCommands, integration);
  }

  async function saveCommand() {
    if (commandEditor && await commandEditor.save()) commandEditor = null;
  }

  /** The confirm opens beside the menu button once the menu has closed and handed focus back. */
  function startRemove() {
    isRenaming = false;
    mcpStore.integrations.clearWriteError(serverId);
    requestAnimationFrame(() => { isConfirmingRemove = true; });
  }

  async function remove() {
    if (await mcpStore.integrations.remove(serverId, integration.id)) {
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
  <IntegrationExtraAccounts {serverId} {integration} />
{/snippet}

{#snippet scopes()}
  <McpAuthWordsField {serverId} {integration} kind="scopes" {canEdit} />
{/snippet}

{#snippet headerNames()}
  <McpAuthWordsField {serverId} {integration} kind="headers" {canEdit} />
{/snippet}

{#snippet oauthClient()}
  <IntegrationOAuthClientForm {serverId} {integration} />
{/snippet}

{#snippet command()}
  {#if commandEditor}
    {@const editor = commandEditor}
    <!-- Escape from any field of the form closes the editor. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void saveCommand(); }}
      onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); commandEditor = null; } }}>
      <McpCommandFields form={editor} idPrefix="mcp-command-edit-{integration.id}" disabled={editor.isSaving || isOffline} />
      <p class="text-chrome-dense text-(--solus-text-secondary)">Saving stops the command. New variable names remove the values saved for the old ones.</p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={editor.isSaving || isOffline}>{editor.isSaving ? "Saving…" : "Save"}</Button>
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={() => { commandEditor = null; }}>Cancel</Button>
      </div>
    </form>
  {:else}
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <p class="break-words font-mono text-chrome-dense leading-6 text-foreground">{subtitle}</p>
        <p class="text-chrome-dense text-(--solus-text-secondary)">In <span class="font-mono">{integration.launch?.cwd ?? "~"}</span> on {hostLabel}</p>
      </div>
      <!-- The process field below says why it is off, once. -->
      <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={!mayRunCommands || !canEdit || isBusy || isOffline}
        aria-label={mayRunCommands ? "Edit the command" : `Edit the command. ${COMMAND_ADMIN_ONLY}`} onclick={editCommand}>Edit</Button>
    </div>
  {/if}
{/snippet}

{#snippet process()}
  <McpCommandProcess {serverId} {integration} {mayRunCommands} />
{/snippet}

{#snippet cliCopies()}
  <McpCliSkipNote skips={cliSkips} />
{/snippet}

{#snippet tools()}
  {@const list = hostState?.tools.get(integration.id)}
  {@const toolError = hostState?.toolErrors.get(integration.id)}
  {#if !toolsListable}
    <p class="text-workspace-chrome text-muted-foreground">{labels.valueNames.length > 0 ? "Enter the values to see its tools." : "Connect to see its tools."}</p>
  {:else if isNotRunning}
    <p class="text-workspace-chrome text-muted-foreground">{notRunningText(integration.name, hostLabel)}</p>
  {:else if toolError}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{toolError}</p>
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => mcpStore.integrations.loadTools(serverId, integration.id)}>Retry</Button>
    </div>
  {:else if !list}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Loading tools…</p>
  {:else if list.length === 0}
    <p class="text-workspace-chrome text-muted-foreground">This server lists no tools.</p>
  {:else}
    <McpToolSwitches integrationName={integration.name} tools={list} {disabledTools} isDisabled={isBusy || isOffline} onToggle={setTool} />
    {#if !isRenaming && !isConfirmingRemove && hostState?.writeError}
      <p role="alert" class="mt-2 break-words text-chrome-dense text-(--solus-status-error)">{hostState.writeError}</p>
    {/if}
  {/if}
{/snippet}

<div class="px-4 py-3" data-testid="integration-row" data-integration-id={integration.id}>
  <div class="flex min-w-0 items-center gap-3">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      aria-expanded={isOpen}
      aria-label="{integration.name}{integration.projectName ? `, ${projectOnlyLabel(integration.projectName)}` : ''}, {status.text}{isNotRunning ? `, ${NOT_RUNNING_LABEL}` : ''}"
      onclick={onToggle}
    >
      <McpServerIcon name={integration.name} url={integration.url} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate text-workspace-chrome font-medium text-foreground">{integration.name}</span>
          {#if integration.projectName}
            <!-- A server from a project's file joins only that project's runs (mcp-first-class.md §8.4). -->
            <span class="max-w-[45%] shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-chrome-dense text-(--solus-text-secondary)">{projectOnlyLabel(integration.projectName)}</span>
          {/if}
        </span>
        <span class="truncate text-chrome-dense text-(--solus-text-tertiary) {isCommand ? 'font-mono' : ''}">{subtitle}</span>
      </span>
      {#if !showConnect && !isOpen}
        <span class="max-w-[40%] shrink-0 truncate text-chrome-dense {rowStatus.isError ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">{rowStatus.text}</span>
      {/if}
    </button>
    {#if showConnect && takesValues}
      <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline}
        onclick={enterValues} aria-label="Enter the values of {integration.name}">Enter values</Button>
    {:else if showConnect}
      <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline}
        onclick={onConnect} aria-label="{connection ? 'Reconnect' : 'Connect'} {integration.name}">{connection ? "Reconnect" : "Connect"}</Button>
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} bind:ref={menuTriggerEl} variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" disabled={isBusy || isOffline} aria-label="More actions for {integration.name}">
            <Ellipsis size={16} />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(18rem,calc(100vw-2rem))]">
        <DropdownMenu.Item disabled={!canEdit} onSelect={startRename}><Pencil size={14} />Rename</DropdownMenu.Item>
        {#if isCommand}
          <DropdownMenu.Item disabled={!canEdit || !mayRunCommands} onSelect={editCommand}><SquareTerminal size={14} />Edit command</DropdownMenu.Item>
        {/if}
        {#if toolsListable && !isNotRunning}
          <DropdownMenu.Item disabled={!canEdit} onSelect={() => setAllTools(false)}><ToggleLeft size={14} />Turn off all tools</DropdownMenu.Item>
          {#if disabledTools.size}<DropdownMenu.Item disabled={!canEdit} onSelect={() => setAllTools(true)}><ToggleRight size={14} />Turn on all tools</DropdownMenu.Item>{/if}
        {/if}
        {#if found}
          <McpFoundFileItems server={found} showTurnOff={false} {canOpenFiles} onOpen={onOpenFile} onAction={startFileDelete} />
          <DropdownMenu.Separator />
        {/if}
        <DropdownMenu.Item variant="destructive" disabled={!canEdit} onSelect={startRemove}><Trash2 size={14} />Remove…</DropdownMenu.Item>
        {#if !canEdit}
          <p class="px-2 py-1.5 text-xs text-muted-foreground">Only its owner can change this server.</p>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <Popover.Root bind:open={isConfirmingRemove}>
      <Popover.Content customAnchor={menuTriggerEl} side="bottom" align="end" sideOffset={6} collisionPadding={8}
        class="w-[min(18rem,calc(100vw-2rem))] gap-3 p-3.5 text-workspace-chrome lg:text-workspace-chrome" aria-label="Remove {integration.name}"
        onOpenAutoFocus={(event) => { event.preventDefault(); removeButtonEl?.focus(); }}>
        <div class="flex flex-col gap-1">
          <p class="font-medium text-foreground">Remove {integration.name}?</p>
          <p class="text-pretty text-(--solus-text-secondary)">{isCommand
            ? `Agents on ${hostLabel} lose its tools. Its process stops, and your values for it are removed.`
            : takesValues
              ? `Agents on ${hostLabel} lose its tools, and your values for it are removed.`
              : `Agents on ${hostLabel} lose its tools. You can add it again from the catalog.`}</p>
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
    {#if found}
      <McpConfirmPopover bind:open={isConfirmingFileDelete} anchor={menuTriggerEl} title="{fileDelete?.label ?? 'Delete'}?"
        text={fileDelete ? `${foundDeleteQuestion(found.name, fileDelete.place)} It stays in Solus.` : ""} action="Delete" busyAction="Deleting…"
        isBusy={isChangingFile} error={fileError} onConfirm={confirmFileDelete} />
    {/if}
    <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" onclick={onToggle} aria-label="{isOpen ? 'Hide' : 'Show'} the details of {integration.name}" aria-expanded={isOpen}>
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
      {#if isCommand}
        {@render field("Command", command)}
        {@render field("Process", process)}
      {/if}
      {#if offersOAuthClientSetup}
        {@render field("OAuth client", oauthClient)}
        {@render field("Scopes", scopes)}
      {/if}
      {#if integration.auth.kind === "headers"}
        {@render field("Headers", headerNames)}
      {/if}
      {#if integration.auth.kind !== "none"}
        {@render field(takesValues ? "Values" : "Account", account)}
      {/if}
      {@render field("Tools", tools)}
      {#if cliSkips.length}
        {@render field("CLI copy", cliCopies)}
      {/if}
      {#if hostState?.facts.get(integration.id)?.instructions}
        <details class="group py-3 text-workspace-chrome">
          <summary class="-ml-1 flex min-h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-md px-1 text-(--solus-text-secondary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={16} class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />Instructions for the agent
          </summary>
          <p class="mt-1 whitespace-pre-wrap break-words pl-6 text-(--solus-text-secondary)" data-testid="integration-instructions">{hostState.facts.get(integration.id)?.instructions}</p>
        </details>
      {/if}
    </div>
  {/if}
</div>
