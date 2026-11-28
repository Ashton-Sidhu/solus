<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  /**
   * The connect dialog of the MCP page (docs/integrations.md): add the server
   * when it is new, sign in, then choose the tools agents may use, and a last
   * step that says what is ready. Escape, the close button, and Cancel before
   * the end take back what the dialog added. It fades and scales in and out,
   * and each step opens and closes in place; with reduced motion it only swaps.
   * The steps are one timeline (`StepRail`): the server, its sign-in (Start
   * and test for a command), and the tools. A done step folds to one line.
   * Add server opens on one field that takes an address, a command, or the
   * JSON of a setup page, which fills the rest of the form. For a command
   * (docs/plans/mcp-first-class.md §7.7) the step ends in Start and test; a
   * person without `host.admin` gets the reason in place of the form. An
   * address goes on, after Continue, as a catalog entry does: the check, the
   * sign-in, and the tools. The sign-in method is chosen only after a refusal.
   */
  import { onMount, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { Dialog } from "bits-ui";
  import { blur, fade, scale } from "svelte/transition";
  import { backOut } from "svelte/easing";
  import { Bot, Check, ExternalLink, LoaderCircle, X } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import MarkdownAlert from "../ui/MarkdownAlert.svelte";
  import * as Table from "../ui/table";
  import StepRail from "../steps/StepRail.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import McpToolSwitches from "./McpToolSwitches.svelte";
  import McpCommandFields from "./McpCommandFields.svelte";
  import McpSourceKindTag from "./McpSourceKindTag.svelte";
  import McpCommandProcess from "./McpCommandProcess.svelte";
  import McpAddressFields from "./McpAddressFields.svelte";
  import McpCommandValues from "./McpCommandValues.svelte";
  import McpBasicCredentialsForm from "./McpBasicCredentialsForm.svelte";
  import { commandHostNote, suggestedCommandName } from "@solus/contracts/integrations/command-server";
  import IntegrationOAuthClientForm from "./IntegrationOAuthClientForm.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import { INTEGRATION_OAUTH_LOOPBACK_URL } from "@solus/contracts/integrations/oauth-callback";
  import { toolAccess } from "@solus/contracts/integration-types";
  import { IntegrationSignIn } from "@solus/contracts/integrations/integration-sign-in";
  import type { SetupHandoff } from "@solus/contracts/integrations/setup-handoff";
  import { getWorkspaceContext, hosts } from "../../contexts";
  import { openChatDraft } from "../../contexts/workspace/new-chat";
  import { connectionStatusText, readyToolsText, urlHost } from "./lib/integration-labels";
  import { McpConnect, type ConnectRequest } from "./lib/mcp-connect.svelte";
  import { connectTimeline, signInWords } from "./lib/connect-timeline";
  import type { McpCatalog } from "./lib/mcp-catalog.svelte";

  interface Props {
    serverId: string;
    hostLabel: string;
    request: ConnectRequest;
    catalog: McpCatalog;
    /** The dialog closed; `integrationId` names the server it connected, if it did. */
    onClose: (integrationId: string | null) => void;
  }

  let { serverId, hostLabel, request, catalog, onClose }: Props = $props();

  const workspace = getWorkspaceContext();

  // The page mounts one dialog per request, so one run serves it for its whole life.
  // A command runs as code on the host: only `host.admin` adds one (§7.2).
  const mayRunCommands = $derived(hosts.get(serverId)?.me.may("host.admin") ?? true);
  const connect = new McpConnect(untrack(() => serverId), untrack(() => request), untrack(() => catalog), () => mayRunCommands);
  let open = $state(true);
  let pasted = $state("");
  let isClosing = false;
  /** The server this dialog connected, kept from the moment it closed until its exit animation ends. */
  let connectedOnClose: string | null = null;
  /** One beat of the dialog's motion; every movement is a multiple of it, and reduced motion makes it zero. */
  const motionMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  /** The height of the dialog's content, so the card grows and shrinks to each step instead of jumping. */
  let bodyHeight = $state(0);

  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const integration = $derived(connect.integration);
  const connection = $derived(integration ? hostState?.connections.get(integration.id) ?? null : null);
  const flow = $derived(integration ? hostState?.connectFlows.get(integration.id) ?? null : null);
  const step = $derived(connect.step);
  let contentEl = $state<HTMLElement | null>(null);

  /** The dialog opens on its first field (the URL on a new server), not on the Close button. */
  function focusFirstField(event: Event) {
    const field = contentEl?.querySelector<HTMLElement>("form input:not([disabled])");
    if (!field) return;
    event.preventDefault();
    field.focus();
  }
  const tools = $derived(integration ? hostState?.tools.get(integration.id) : undefined);
  const toolError = $derived(integration ? hostState?.toolErrors.get(integration.id) : undefined);
  const enabledTools = $derived(tools?.filter((tool) => !connect.disabledDraft.has(tool.name)) ?? []);
  const name = $derived(integration?.name ?? connect.target.name);
  const commandForm = $derived(connect.command);
  const addForm = $derived(connect.addForm);
  /** The server is a command: its second step is Start and test. */
  const isCommand = $derived(!!commandForm && connect.sourceKind === "command" && (addForm === "source" || connect.isCommandStarted));
  /** What the field reads as, shown at its end. */
  const sourceTag = $derived(isCommand ? "command" : connect.sourceKind === "url" ? "url" : null);
  const isOffline = $derived(!!hostState?.isDisconnected);
  const connectionProblem = $derived(connection && connection.status !== "connected" ? connectionStatusText(connection) : null);
  /** What the sign-in step shows now; a change fades the new content in. */
  const signInView = $derived(addForm ?? (!integration ? "adding" : step === "oauth-client" ? step : flow && flow.kind !== "failed" ? flow.kind : "ready"));
  const title = $derived(request.addsServer ? "Add an MCP server" : `Connect ${name}`);
  const commandPreview = $derived(commandForm?.preview ?? null);
  const timeline = $derived(connectTimeline({
    step,
    isCommand,
    isStarting: connect.isStartingCommand,
    server: isCommand
      ? { name: integration?.name ?? (commandForm?.name.trim() || (commandPreview ? suggestedCommandName(commandPreview) : "Command")), where: commandForm?.line ?? "" }
      : { name: name || urlHost(connect.target.url), where: [urlHost(integration?.url ?? connect.target.url), signInWords(integration?.auth)].filter(Boolean).join(" · ") },
    signedInText: connection?.status === "connected" ? connectionStatusText(connection).text : "Ready",
  }));

  const description = $derived(tools ? `Your agents get ${tools.length === 1 ? "1 new tool" : `${tools.length} new tools`} once this is connected.` : `Its tools reach every agent on ${hostLabel}.`);
  /** The names a `headers` server takes values for (docs/plans/mcp-add-server.md); empty for the other kinds. */
  const valueNames = $derived(integration ? new IntegrationSignIn(integration).valueNames : []);
  /** The server asks for HTTP Basic: a user name and a password in place of a key. */
  const takesUsernameAndPassword = $derived(integration ? new IntegrationSignIn(integration).takesUsernameAndPassword : false);
  /** The header values typed in the sign-in step, until Save hands them over. */
  const valueDrafts = new SvelteMap<string, string>();

  onMount(() => { void connect.start(); });

  // The tools step reads the server's tool list once the host can list it.
  $effect(() => {
    if (step === "tools" && integration && !tools && !toolError) untrack(() => void mcpStore.integrations.loadTools(serverId, integration.id));
  });

  function close() {
    open = false;
    settle();
  }

  /** Runs once when the dialog starts to close: ends the sign-in, and takes back an unfinished add. */
  function settle() {
    if (isClosing) return;
    isClosing = true;
    connectedOnClose = connect.isDone ? connect.integrationId : null;
    void connect.dismiss();
  }

  /** "Set up with an agent" (§13.4): a new chat on this host, its prompt ready to send; the server this dialog added stays. */
  function handOff(handoff: SetupHandoff) {
    const prompt = handoff.prompt;
    connect.keepForHandoff();
    close();
    workspace.router.close("settings");
    openChatDraft(workspace, "click", { serverId, prompt });
  }

  async function submitPasted(event: SubmitEvent) {
    event.preventDefault();
    if (!integration) return;
    const value = pasted;
    pasted = "";
    if (!(await mcpStore.integrations.submit(serverId, integration.id, value))) pasted = value;
  }

  /** A user name and a password, encoded by their form, go as the key. */
  async function submitKey(key: string): Promise<boolean> {
    return integration ? mcpStore.integrations.submit(serverId, integration.id, key) : false;
  }

  /** The header values go to the host in this one call; the drafts are cleared. */
  async function submitValues(event: SubmitEvent) {
    event.preventDefault();
    if (!integration) return;
    const values = valueNames.map((valueName) => ({ name: valueName, value: valueDrafts.get(valueName) ?? "" }));
    valueDrafts.clear();
    await mcpStore.integrations.submitValues(serverId, integration.id, values);
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => open });
</script>

{#snippet pending(text: string)}
  <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground">
    <LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />{text}
  </p>
{/snippet}

<!-- An error of the whole step is a Caution callout; an error of one field stays under that field. -->
{#snippet errorAlert(message: string)}
  {#snippet body()}<p class="m-0 break-words text-pretty">{message}</p>{/snippet}
  <div role="alert"><MarkdownAlert alertType="caution" content={body} /></div>
{/snippet}

{#snippet pasteForm(label: string, fieldId: string, type: "text" | "password", error: string | undefined)}
  <form class="flex flex-col gap-1.5" onsubmit={submitPasted}>
    <label for={fieldId} class="text-workspace-chrome font-medium text-foreground">{label}</label>
    <div class="flex items-center gap-2">
      <!-- svelte-ignore a11y_autofocus -->
      <Input id={fieldId} {type} bind:value={pasted} autofocus autocomplete="off" spellcheck={false} dictation={false} disabled={isOffline}
        class="h-8 min-w-0 flex-1 text-workspace-chrome" aria-invalid={error ? true : undefined} />
      <Button type="submit" size="default" class="pointer-coarse:min-h-11" disabled={isOffline || !pasted.trim()}>Submit</Button>
    </div>
    {#if error}<p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{error}</p>{/if}
  </form>
{/snippet}

{#snippet signIn()}
  {#if !integration}
    {#if connect.addError}
      <div class="flex flex-col gap-3">
        {@render errorAlert(connect.addError)}
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={() => connect.start()}>Try again</Button>
          {#if request.addsServer}
            <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={() => connect.editAddress()}>Change the address or sign-in method</Button>
          {/if}
        </div>
      </div>
    {:else}
      {@render pending(`Checking ${urlHost(connect.target.url)}…`)}
    {/if}
  {:else if step === "oauth-client"}
    <IntegrationOAuthClientForm {serverId} {integration} />
  {:else if flow?.kind === "starting"}
    {@render pending("Starting the sign-in…")}
  {:else if flow?.kind === "waiting"}
    {@render pending(flow.through === "cloud" ? "Authorizing through Solus Cloud…" : `Waiting for ${name}’s sign-in page…`)}
    <p class="text-workspace-chrome text-(--solus-text-secondary)">
      Window not showing up?
      <button type="button" class="rounded text-(--solus-accent) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onclick={() => mcpStore.integrations.openInBrowser(flow.url)}>Reopen it</button>
    </p>
    {#if flow.input === "redirect-url"}
      {@render pasteForm("Paste the address of the page you landed on", `mcp-connect-redirect-${integration.id}`, "text", flow.error)}
    {/if}
  {:else if flow?.kind === "token" && takesUsernameAndPassword}
    <McpBasicCredentialsForm idPrefix="mcp-connect-basic-{integration.id}" error={flow.error} disabled={isOffline} autofocus onsubmit={submitKey} />
  {:else if flow?.kind === "token"}
    {@render pasteForm(`API key for ${name}`, `mcp-connect-key-${integration.id}`, "password", flow.error)}
  {:else if flow?.kind === "submitting"}
    {@render pending("Finishing sign-in…")}
  {:else if valueNames.length > 0}
    <form class="flex flex-col gap-3" onsubmit={submitValues}>
      <p class="text-pretty text-workspace-chrome text-(--solus-text-secondary)">{name} takes {valueNames.length === 1 ? "a header" : "headers"} from you. Each value is a secret, saved for you alone on {hostLabel}.</p>
      <McpCommandValues names={[...valueNames]} values={valueDrafts} hasSaved={connection?.status === "connected"} idPrefix="mcp-connect-header-{integration.id}" disabled={isOffline} autofocus />
      {#if flow?.kind === "values" && flow.error}
        {@render errorAlert(flow.error)}
      {:else if connectionProblem}
        {@render errorAlert(`${connectionProblem.text}${connectionProblem.detail ? `: ${connectionProblem.detail}` : ""}`)}
      {/if}
      <div><Button type="submit" size="sm" class="pointer-coarse:min-h-11" disabled={isOffline}>Save values</Button></div>
    </form>
  {:else}
    {#if takesUsernameAndPassword}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">{name} asks for a user name and a password. They are saved for you alone, and agents never see them.</p>
    {:else if integration.auth.kind === "bearer"}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">{name} signs in with an API key. Create one at {urlHost(integration.url)}, then paste it here.</p>
    {:else}
      <p class="text-pretty text-workspace-chrome text-(--solus-text-secondary)">Approve Solus on {name}’s sign-in page, then come back here to choose the tools.</p>
    {/if}
    {#if flow?.kind === "failed"}
      {@render errorAlert(flow.message)}
    {:else if connectionProblem}
      {@render errorAlert(`${connectionProblem.text}${connectionProblem.detail ? `: ${connectionProblem.detail}` : ""}`)}
    {/if}
    {#snippet signInButton()}
      <Button class="pointer-coarse:min-h-11" disabled={isOffline || hostState?.connectionsStatus !== "loaded"} onclick={() => mcpStore.integrations.connect(serverId, integration.id)}>
        {takesUsernameAndPassword ? "Enter a user name and password" : integration.auth.kind === "bearer" ? `Enter an API key` : `Sign in to ${name}`}{#if integration.auth.kind !== "bearer"}<ExternalLink size={14} />{/if}
      </Button>
    {/snippet}
    {#if integration.auth.kind === "oauth"}
      <!-- The form puts Sign in and "Use your own OAuth app" in one row. -->
      <IntegrationOAuthClientForm {serverId} {integration} primaryAction={signInButton} />
    {:else}
      <div>{@render signInButton()}</div>
    {/if}
  {/if}
  {#if request.authHelp && connect.setupHandoff}
    <!-- The vendor's own page for the client or the key (§13.5). -->
    <p class="text-chrome-dense text-(--solus-text-secondary)">
      <button type="button" class="inline-flex items-center gap-1 rounded text-(--solus-accent) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onclick={() => request.authHelp && mcpStore.integrations.openInBrowser(request.authHelp)}>{name} setup guide<ExternalLink size={12} /></button>
    </p>
  {/if}
  {#if connect.setupHandoff}
    {@const handoff = connect.setupHandoff}
    <p class="border-t border-border pt-3 text-pretty text-chrome-dense text-(--solus-text-secondary)">
      {handoff.hint}
      <button type="button" class="inline-flex items-center gap-1 rounded text-(--solus-accent) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:no-underline pointer-coarse:min-h-11"
        disabled={isOffline} onclick={() => handOff(handoff)}><Bot size={12} />Set up with an agent</button>
    </p>
  {/if}
{/snippet}

{#snippet configNote()}
  <p class="m-0 text-pretty">Filled in from the pasted config.{#if isCommand && commandForm?.hasValues} Each value is a secret, saved for you alone on {hostLabel}.{/if}{#if !isCommand && connect.addressForm.clientId} Its OAuth client ID goes with the add.{/if}</p>
{/snippet}

<!-- The one field: an address, a command, or a setup page's JSON. A command shows its own fields under it. -->
{#snippet sourceStep()}
  <form id="mcp-source-form" class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void connect.continueFromSource(); }}>
    <label for="mcp-source" class="sr-only">URL, command, or config</label>
    <!-- The same field as every other one in the dialog; pasted JSON arrives on one line and reads the same. -->
    <div class="relative min-w-0">
      <!-- svelte-ignore a11y_autofocus -->
      <Input id="mcp-source" value={connect.source} oninput={(event) => connect.setSource(event.currentTarget.value)}
        placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck={false} dictation={false} autofocus
        disabled={isOffline || connect.isStartingCommand} aria-invalid={connect.sourceProblem || commandForm?.lineProblem ? true : undefined} aria-describedby="mcp-source-hint"
        class="h-8 min-w-0 text-workspace-chrome {isCommand ? 'font-mono' : ''} {sourceTag ? 'pr-28' : ''}" />
      {#if sourceTag}<McpSourceKindTag kind={sourceTag} />{/if}
    </div>
    {#if connect.sourceProblem}
      <p id="mcp-source-hint" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{connect.sourceProblem}</p>
    {:else if isCommand && commandForm?.lineProblem}
      <p id="mcp-source-hint" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{commandForm.lineProblem}</p>
    {:else}
      <p id="mcp-source-hint" class="text-pretty text-chrome-dense text-(--solus-text-secondary)">
        {isCommand ? commandHostNote(hostLabel) : connect.sourceKind === "url" ? "Solus checks how it signs in when you continue." : "Paste an https:// address, a command such as npx -y @acme/mcp, or the JSON from a server’s setup page."}
      </p>
    {/if}
    {#if connect.isFilledFromConfig}
      <MarkdownAlert alertType="note" content={configNote} />
    {/if}
    {#if isCommand && commandForm?.refusal}
      <MarkdownAlert alertType="caution" content={commandRefusal} />
    {:else if isCommand && commandForm}
      <McpCommandFields form={commandForm} idPrefix="mcp-command-add" showLine={false} showValues disabled={connect.isStartingCommand || isOffline}
        hasSavedValues={connection?.status === "connected"} />
      {#if integration}
        <McpCommandProcess {serverId} {integration} {mayRunCommands} withActions={false} />
      {/if}
    {/if}
  </form>
{/snippet}

{#snippet commandRefusal()}
  <p class="m-0 text-pretty" data-testid="mcp-command-refusal">{commandForm?.refusal}</p>
{/snippet}

{#snippet addressStep()}
  <form id="mcp-address-form" onsubmit={(event) => { event.preventDefault(); void connect.continueWithAddress(); }}>
    <McpAddressFields form={connect.addressForm} callbackUrl={INTEGRATION_OAUTH_LOOPBACK_URL} disabled={isOffline} />
  </form>
{/snippet}

{#snippet toolsStep()}
  {#if !integration}
    <!-- Not reached: the tools step needs the record. -->
  {:else if toolError}
    {@render errorAlert(toolError)}
    <div>
      <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={() => mcpStore.integrations.loadTools(serverId, integration.id)}>Retry</Button>
    </div>
  {:else if !tools}
    {@render pending("Loading tools…")}
  {:else if tools.length === 0}
    <p class="text-workspace-chrome text-muted-foreground">This server lists no tools.</p>
  {:else}
    <McpToolSwitches integrationName={name} {tools} disabledTools={connect.disabledDraft} isDisabled={connect.isSaving}
      onToggle={(toolName, isOn) => connect.setTool(toolName, isOn)} />
  {/if}
  {#if connect.saveError}
    {@render errorAlert(connect.saveError)}
  {/if}
{/snippet}

{#snippet footerButtons()}
  {#if step === "source"}
    <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={close}>Cancel</Button>
    <Button type="submit" form="mcp-source-form" size="sm" class="pointer-coarse:min-h-11" disabled={isOffline || connect.sourceKind === "empty"}>Continue</Button>
  {:else if step === "command" && !commandForm?.refusal}
    <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={() => (connect.isStartingCommand ? connect.cancelCommandStart() : close())}>{connect.isStartingCommand ? "Stop" : "Cancel"}</Button>
    <Button type="submit" form="mcp-source-form" size="sm" class="pointer-coarse:min-h-11" disabled={connect.isStartingCommand || isOffline || !commandForm?.line.trim()}>
      {#if connect.isStartingCommand}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Starting…{:else}Start and test{/if}
    </Button>
  {:else if step === "address"}
    <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={close}>Cancel</Button>
    <Button type="submit" form="mcp-address-form" size="sm" class="pointer-coarse:min-h-11" disabled={isOffline || !connect.addressForm.address.trim()}>Continue</Button>
  {:else if step === "tools"}
    <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={close}>Cancel</Button>
    <Button size="sm" class="pointer-coarse:min-h-11" disabled={!tools || connect.isSaving || isOffline} onclick={() => connect.finish()}>
      {connect.isSaving ? "Saving…" : request.addsServer ? `Add ${name}` : `Connect ${name}`}
    </Button>
  {:else}
    <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={close}>{commandForm?.refusal ? "Close" : "Cancel"}</Button>
  {/if}
{/snippet}

<!-- The page unmounts the dialog only after its exit animation, so the close is seen. -->
<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) settle(); }} onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(connectedOnClose); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <!-- Centred with margins, not a translate, so the zoom of the animation does not fight the position. -->
    <Dialog.Content
      bind:ref={contentEl}
      onOpenAutoFocus={focusFirstField}
      class="settings-controls text-workspace-chrome fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(46rem,calc(100vw-2rem))] flex-col overflow-y-auto rounded-2xl bg-(--solus-popover-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      data-testid="mcp-connect-dialog"
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 z-10 text-muted-foreground pointer-coarse:tap-area" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>

      <!-- The card follows its content's height, so each step change resizes it smoothly.
           The inner padding keeps focus rings inside the clip. -->
      <div class="-m-1 overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none" style:height={bodyHeight ? `${bodyHeight}px` : undefined}>
      <div class="p-1" bind:clientHeight={bodyHeight}>
      {#if connect.isDone}
        <!-- A glow grows from the check across the top of the card, once. -->
        <div class="pointer-events-none absolute -inset-x-16 top-0 h-60 bg-[radial-gradient(50%_100%_at_50%_0%,color-mix(in_oklch,var(--solus-status-complete)_24%,transparent),transparent)]"
          in:scale={{ start: 0.2, opacity: 0, duration: motionMs * 4 }} aria-hidden="true"></div>
        <div class="relative flex flex-col">
        <div class="flex flex-col items-center gap-1 pt-2 pb-5 text-center">
          <span class="mb-3 flex size-9 items-center justify-center rounded-full bg-(--solus-status-complete) text-white shadow-[0_0_0_6px_color-mix(in_oklch,var(--solus-status-complete)_16%,transparent)]"
            in:scale={{ start: 0.2, duration: motionMs * 2.2, easing: backOut }}><Check size={18} /></span>
          <div class="flex flex-col gap-1" in:blur={{ amount: 6, duration: motionMs * 2, delay: motionMs * 0.7 }}>
            <Dialog.Title class="font-medium text-foreground">{name} is connected</Dialog.Title>
            <Dialog.Description class="text-(--solus-text-secondary)">{readyToolsText(enabledTools.length)}</Dialog.Description>
          </div>
        </div>
        <div class="flex flex-col" in:fade={{ duration: motionMs * 1.5, delay: motionMs * 1.2 }}>
        {#if enabledTools.length > 0}
          <Table.Root containerClass="max-h-64 overflow-y-auto bg-white" class="table-fixed" aria-label="Tools agents can use">
            <Table.Body>
              {#each enabledTools as tool (tool.name)}
                <Table.Row>
                  <Table.Cell class="truncate text-foreground">{tool.title || tool.name}</Table.Cell>
                  <Table.Cell class="w-28 text-end">
                    <span class="rounded-md bg-muted px-1.5 py-0.5 text-chrome-dense text-(--solus-text-secondary)">{toolAccess(tool)}</span>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
        <div class="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={close}>Close</Button>
        </div>
        </div>
        </div>
      {:else}
        <div class="flex flex-col gap-5">
          <div class="flex flex-col gap-1 pr-8">
            {#if !request.addsServer}
              <span class="mb-3">
                <McpServerIcon name={name || "Server"} url={integration?.url ?? connect.target.url} icon={request.icon} serverIcon={integration?.icon} />
              </span>
            {/if}
            <Dialog.Title class="font-medium text-foreground">{title}</Dialog.Title>
            <Dialog.Description class="text-pretty text-(--solus-text-secondary)">{description}</Dialog.Description>
          </div>

          <div class="border-t border-(--hairline) pt-5 text-workspace-chrome">
            <StepRail steps={timeline}>
              {#snippet trailing(item)}
                {#if item.key === "server" && item.state === "done" && connect.canChangeServer}
                  <button type="button" class="shrink-0 rounded-sm font-medium leading-5.5 text-(--solus-text-tertiary) outline-none hover:text-(--solus-text-primary) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11"
                    aria-label="Change the server" disabled={isOffline || connect.isStartingCommand} onclick={() => void connect.changeServer()}>Change</button>
                {/if}
              {/snippet}
              {#snippet detail(item)}
                {#if item.state === "current"}
                  <div class="mt-3 flex min-w-0 flex-col gap-3">
                    {#if item.key === "server"}
                      {#if step === "address"}{@render addressStep()}{:else}{@render sourceStep()}{/if}
                    {:else if item.key === "sign-in"}
                      {#key signInView}
                        <div class="flex flex-col gap-3" in:fade={{ duration: motionMs }}>
                          {#if isCommand}{@render pending("Starting the command and listing its tools…")}{:else}{@render signIn()}{/if}
                        </div>
                      {/key}
                    {:else}
                      {@render toolsStep()}
                    {/if}
                  </div>
                {/if}
              {/snippet}
            </StepRail>
          </div>

          <div class="flex justify-end gap-2">{@render footerButtons()}</div>
        </div>
      {/if}
      </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
