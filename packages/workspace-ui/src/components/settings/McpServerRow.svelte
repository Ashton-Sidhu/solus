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
   * Until a server is connected, its details are the add dialog's timeline
   * (docs/plans/mcp-add-server.md): the server, its sign-in, then its tools.
   */
  import { ChevronRight, ChevronUp, CircleAlert, CircleCheck, CirclePause, CircleX, Ellipsis, Folder, LoaderCircle, Monitor, Pencil, SquareTerminal, ToggleLeft, ToggleRight, Trash2 } from "@lucide/svelte";
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
  import StepRail from "../steps/StepRail.svelte";
  import { McpCommandForm } from "./lib/mcp-command.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import { hosts } from "../../contexts";
  import { IntegrationLabels, urlHost } from "./lib/integration-labels";
  import { signInWords } from "./lib/connect-timeline";
  import { mcpRowIsOpen } from "./lib/mcp-row-open";

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
  /** The person closed the row while a sign-in ran: their close wins over the sign-in that opened it. */
  let isClosedByPerson = $state(false);
  // A running sign-in shows in the body, so the row opens by itself while it runs.
  const isOpen = $derived(mcpRowIsOpen({ isExpanded, isSignInRunning: !!flow && flow.kind !== "failed", isClosedByPerson }));
  const showConnect = $derived(status.canConnect && !isOpen && hostState?.connectionsStatus === "loaded");
  const offersOAuthClientSetup = $derived(integration.auth.kind === "oauth");
  const disabledTools = $derived(new Set(integration.disabledTools));
  const toolList = $derived(hostState?.tools.get(integration.id));
  /** Every tool is off, as far as the listed tools show: agents get nothing from it. */
  const isOff = $derived(!!toolList?.length && toolList.every((tool) => disabledTools.has(tool.name)));
  const toolsOnCount = $derived(toolList?.filter((tool) => !disabledTools.has(tool.name)).length ?? 0);
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
  const rowStatus = $derived<{ text: string; tone: "ready" | "muted" | "attention" | "error" }>(isOff
    ? { text: "Off", tone: "muted" }
    : processStatus && (status.tone === "ready" || !status.canConnect)
    ? { text: processStatus.label, tone: processStatus.tone }
    : isNotRunning && (status.tone === "ready" || !status.canConnect)
      ? { text: NOT_RUNNING_LABEL, tone: "muted" }
      : { text: status.text, tone: status.tone });
  const subtitle = $derived(integration.launch ? commandLineText(integration.launch) : urlHost(integration.url));
  /** Not connected yet: the details are the add dialog's timeline, with the sign-in step open. */
  const showsSetupSteps = $derived(!isCommand && integration.auth.kind !== "none" && !toolsListable);
  const setupSteps = $derived([
    { key: "server", title: "Server", hint: [subtitle, signInWords(integration.auth)].filter(Boolean).join(" · "), state: "done" as const },
    { key: "sign-in", title: takesValues ? "Values" : "Sign in", hint: takesValues ? "Each value is a secret, saved for you alone on this host." : "Give Solus access to its tools.", state: "current" as const },
    { key: "tools", title: "Choose tools", hint: takesValues ? "Enter the values to see its tools." : "Connect to see its tools.", state: "next" as const },
  ]);

  /** The chevron and the tile: close also closes a row that a running sign-in opened. */
  function toggleOpen() {
    if (isOpen) {
      isClosedByPerson = true;
      if (isExpanded) onToggle();
      return;
    }
    isClosedByPerson = false;
    onToggle();
  }

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
  <!-- A small muted label over its content, as the page's own groups are headed. -->
  <div class="flex min-w-0 flex-col gap-1.5">
    <p class="text-chrome-dense font-medium text-muted-foreground">{label}</p>
    <div class="flex min-w-0 flex-col">{@render content()}</div>
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
    <!-- One line: the command, the folder it runs in, and its host. -->
    <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <code class="flex min-w-0 max-w-full items-center gap-1.5 font-mono text-chrome-dense text-foreground" title={subtitle}>
        <ChevronRight size={12} class="shrink-0 text-muted-foreground" aria-hidden="true" /><span class="truncate">{subtitle}</span>
      </code>
      <span class="flex min-w-0 items-center gap-1.5 text-chrome-dense text-muted-foreground" title="Folder">
        <Folder size={14} class="shrink-0" aria-hidden="true" /><span class="sr-only">In</span><span class="truncate">{integration.launch?.cwd ?? "~"}</span>
      </span>
      <span class="flex min-w-0 items-center gap-1.5 text-chrome-dense text-muted-foreground" title="Host">
        <Monitor size={14} class="shrink-0" aria-hidden="true" /><span class="sr-only">on</span><span class="truncate">{hostLabel}</span>
      </span>
      <!-- The process below says why it is off, once. -->
      <Button variant="ghost" size="sm" class="ml-auto shrink-0 text-workspace-chrome text-(--solus-text-secondary) pointer-coarse:min-h-11" disabled={!mayRunCommands || !canEdit || isBusy || isOffline}
        aria-label={mayRunCommands ? "Edit the command" : `Edit the command. ${COMMAND_ADMIN_ONLY}`} onclick={editCommand}><Pencil size={14} />Edit</Button>
    </div>
  {/if}
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

<!-- A tile in the Installed grid, drawn as a catalog entry is. Open, it spans
     the grid as a card, and the tiles after it flow on below. -->
<li class="min-w-0 {isOpen ? 'col-span-full my-2 rounded-xl border border-border bg-white px-4 pt-1 pb-2 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none' : 'py-3'}"
  data-testid="integration-row" data-integration-id={integration.id}>
  <div class="flex min-w-0 items-center gap-3 {isOpen ? 'py-2' : ''}">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-3.5 overflow-hidden rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      aria-expanded={isOpen}
      aria-label="{integration.name}{integration.projectName ? `, ${projectOnlyLabel(integration.projectName)}` : ''}, {status.text}{isNotRunning ? `, ${NOT_RUNNING_LABEL}` : ''}"
      onclick={toggleOpen}
    >
      <McpServerIcon name={integration.name} url={integration.url} serverIcon={integration.icon} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate text-workspace-chrome leading-5 font-medium text-foreground">{integration.name}</span>
          <!-- The state sits beside the name, so it reads with the server it names. -->
          <span class="flex max-w-[50%] shrink-0 items-center gap-1.5 overflow-hidden text-chrome-dense leading-5 {rowStatus.tone === 'error' ? 'text-(--solus-status-error)' : rowStatus.tone === 'attention' ? 'text-(--solus-status-permission)' : 'text-muted-foreground'}">
            {#if rowStatus.tone === "ready"}<CircleCheck size={14} class="shrink-0 text-(--solus-status-complete)" aria-hidden="true" />
            {:else if rowStatus.tone === "error"}<CircleX size={14} class="shrink-0" aria-hidden="true" />
            {:else if rowStatus.tone === "attention"}<CircleAlert size={14} class="shrink-0" aria-hidden="true" />
            {:else}<CirclePause size={14} class="shrink-0" aria-hidden="true" />{/if}
            <span class="truncate">{rowStatus.text}</span>
          </span>
          {#if integration.projectName}
            <!-- A server from a project's file joins only that project's runs (mcp-first-class.md §8.4). -->
            <span class="max-w-[45%] shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-chrome-dense text-(--solus-text-secondary)">{projectOnlyLabel(integration.projectName)}</span>
          {/if}
        </span>
        <!-- Open, a command's line shows in full below, so the header names its kind. -->
        <span class="truncate text-chrome-dense leading-5 text-muted-foreground {isCommand && !isOpen ? 'font-mono' : ''}">{isCommand && isOpen ? "Command server" : subtitle}</span>
      </span>
    </button>
    {#if showConnect && takesValues}
      <Button variant="outline" size="sm" class="shrink-0 border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isOffline}
        onclick={enterValues} aria-label="Enter the values of {integration.name}">Enter values</Button>
    {:else if showConnect}
      <Button variant="outline" size="sm" class="shrink-0 border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isOffline}
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
    {#if isOpen}
      <!-- Closed, the tile itself opens the details; open, this closes them. -->
      <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" onclick={toggleOpen} aria-label="Hide the details of {integration.name}" aria-expanded={isOpen}>
        <ChevronUp size={16} />
      </Button>
    {/if}
  </div>

  {#if isOpen}
    <!-- Inset to the name above it once there is room, so the details read as the server's. -->
    <div class="flex flex-col gap-5 pt-1 pb-2 @min-[30rem]/pane:pl-11.5">
      {#if isRenaming}
        <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); void saveRename(); }}>
          <!-- svelte-ignore a11y_autofocus -->
          <Input bind:value={renameDraft} aria-label="Name of {integration.name}" class="h-8 min-w-0 flex-1 text-workspace-chrome" autofocus
            onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); isRenaming = false; } }} />
          <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { isRenaming = false; }}>Cancel</Button>
          <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || !renameDraft.trim()}>{isBusy ? "Saving…" : "Save"}</Button>
        </form>
      {/if}
      {#if isRenaming && hostState?.writeError}
        <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{hostState.writeError}</p>
      {/if}
      {#if isCommand}
        <div class="flex min-w-0 flex-col gap-3">
          {@render command()}
          <McpCommandProcess {serverId} {integration} {mayRunCommands} />
        </div>
      {/if}
      {#if showsSetupSteps}
        <!-- Not connected yet: the add dialog's timeline, with the sign-in step open. -->
        <div class="text-workspace-chrome">
          <StepRail steps={setupSteps}>
            {#snippet detail(step)}
              {#if step.key === "sign-in"}
                <div class="mt-3 flex min-w-0 flex-col gap-4">
                  {#if offersOAuthClientSetup}
                    {@render oauthClient()}
                  {/if}
                  {@render account()}
                  {#if offersOAuthClientSetup}
                    {@render field("Scopes", scopes)}
                  {/if}
                  {#if integration.auth.kind === "headers"}
                    {@render field("Headers", headerNames)}
                  {/if}
                </div>
              {/if}
            {/snippet}
          </StepRail>
        </div>
      {:else}
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
      <div class="flex min-w-0 flex-col gap-1.5">
        <div class="flex min-h-7 items-center justify-between gap-4">
          <p class="flex items-baseline gap-2 text-chrome-dense font-medium text-muted-foreground">
            Tools
            {#if toolList?.length && toolsListable && !isNotRunning}
              <span class="font-normal tabular-nums">{toolsOnCount} of {toolList.length} on</span>
            {/if}
          </p>
          {#if toolList?.length && toolsListable && !isNotRunning}
            <Button variant="ghost" size="sm" class="-mr-2 shrink-0 text-workspace-chrome text-(--solus-text-secondary) pointer-coarse:min-h-11" disabled={!canEdit || isBusy || isOffline}
              onclick={() => setAllTools(isOff)}>{isOff ? "Turn all on" : "Turn all off"}</Button>
          {/if}
        </div>
        {@render tools()}
      </div>
      {/if}
      {#if cliSkips.length}
        {@render field("CLI copy", cliCopies)}
      {/if}
      {#if hostState?.facts.get(integration.id)?.instructions}
        <details class="group text-workspace-chrome">
          <summary class="-ml-1 flex min-h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-md px-1 text-(--solus-text-secondary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={16} class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />Instructions for the agent
          </summary>
          <p class="mt-1 whitespace-pre-wrap break-words pl-6 text-(--solus-text-secondary)" data-testid="integration-instructions">{hostState.facts.get(integration.id)?.instructions}</p>
        </details>
      {/if}
    </div>
  {/if}
</li>
