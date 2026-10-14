<script lang="ts">
  /**
   * The connect dialog of the MCP page (docs/integrations.md): add the server
   * when it is new, sign in, then choose the tools agents may use, and a last
   * step that says what is ready. Escape, the close button, and Cancel before
   * the end take back what the dialog added. It fades and scales in and out,
   * and each step opens and closes in place; with reduced motion it only swaps.
   */
  import { onMount, untrack } from "svelte";
  import { Dialog } from "bits-ui";
  import { blur, fade, fly, scale } from "svelte/transition";
  import { backOut } from "svelte/easing";
  import { Check, ExternalLink, LoaderCircle, X } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { RowCard } from "../ui/row-card";
  import * as Table from "../ui/table";
  import McpServerIcon from "./McpServerIcon.svelte";
  import McpToolSwitches from "./McpToolSwitches.svelte";
  import IntegrationOAuthClientForm from "./IntegrationOAuthClientForm.svelte";
  import { integrationsStore } from "./integrations.store.svelte";
  import { toolAccess } from "@solus/contracts/integration-types";
  import { connectionStatusText, readyToolsText, urlHost } from "./lib/integration-labels";
  import { McpConnect, type ConnectRequest } from "./lib/mcp-connect.svelte";
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

  // The page mounts one dialog per request, so one run serves it for its whole life.
  const connect = new McpConnect(untrack(() => serverId), untrack(() => request), untrack(() => catalog));
  let open = $state(true);
  let pasted = $state("");
  let isClosing = false;
  /** The server this dialog connected, kept from the moment it closed until its exit animation ends. */
  let connectedOnClose: string | null = null;
  /** One beat of the dialog's motion; every movement is a multiple of it, and reduced motion makes it zero. */
  const motionMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  /** The height of the dialog's content, so the card grows and shrinks to each step instead of jumping. */
  let bodyHeight = $state(0);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const integration = $derived(connect.integration);
  const connection = $derived(integration ? hostState?.connections.get(integration.id) ?? null : null);
  const flow = $derived(integration ? hostState?.connectFlows.get(integration.id) ?? null : null);
  const step = $derived(connect.step);
  const tools = $derived(integration ? hostState?.tools.get(integration.id) : undefined);
  const toolError = $derived(integration ? hostState?.toolErrors.get(integration.id) : undefined);
  const enabledTools = $derived(tools?.filter((tool) => !connect.disabledDraft.has(tool.name)) ?? []);
  const name = $derived(integration?.name ?? request.name);
  const isOffline = $derived(!!hostState?.isDisconnected);
  const needsSignIn = $derived(!!integration && integration.auth.kind !== "none");
  const connectionProblem = $derived(connection && connection.status !== "connected" ? connectionStatusText(connection) : null);
  /** What the sign-in step shows now; a change fades the new content in. */
  const signInView = $derived(!integration ? "adding" : step === "oauth-client" ? step : flow && flow.kind !== "failed" ? flow.kind : "ready");

  onMount(() => { void connect.start(); });

  // The tools step reads the server's tool list once the host can list it.
  $effect(() => {
    if (step === "tools" && integration && !tools && !toolError) untrack(() => void integrationsStore.loadTools(serverId, integration.id));
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

  async function submitPasted(event: SubmitEvent) {
    event.preventDefault();
    if (!integration) return;
    const value = pasted;
    pasted = "";
    if (!(await integrationsStore.submit(serverId, integration.id, value))) pasted = value;
  }
</script>

{#snippet pending(text: string)}
  <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground">
    <LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />{text}
  </p>
{/snippet}

{#snippet stepMark(number: number, state: "done" | "current" | "next")}
  <span class="flex size-7 shrink-0 items-center justify-center rounded-full border text-chrome-dense font-medium tabular-nums transition-colors duration-300 motion-reduce:transition-none {state === 'done'
    ? 'border-transparent bg-(--solus-status-complete-bg) text-foreground'
    : state === 'current'
      ? 'border-(--solus-accent) text-foreground'
      : 'border-border text-muted-foreground'}" aria-hidden="true">
    {#if state === "done"}
      <!-- The number gives way to the check once the sign-in has faded. -->
      <span class="flex" in:scale={{ start: 0.3, duration: motionMs * 1.4, delay: motionMs * 0.6, easing: backOut }}><Check size={14} class="text-(--solus-status-complete)" /></span>
    {:else}{number}{/if}
  </span>
{/snippet}

{#snippet pasteForm(label: string, fieldId: string, type: "text" | "password", error: string | undefined)}
  <form class="flex flex-col gap-1.5" onsubmit={submitPasted}>
    <label for={fieldId} class="text-workspace-chrome font-medium text-foreground">{label}</label>
    <div class="flex items-center gap-2">
      <!-- svelte-ignore a11y_autofocus -->
      <Input id={fieldId} {type} bind:value={pasted} autofocus autocomplete="off" spellcheck={false} dictation={false} disabled={isOffline}
        class="h-8 min-w-0 flex-1 text-workspace-chrome" aria-invalid={error ? true : undefined} />
      <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || !pasted.trim()}>Submit</Button>
    </div>
    {#if error}<p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{error}</p>{/if}
  </form>
{/snippet}

{#snippet signIn()}
  {#if !integration}
    {#if connect.addError}
      <div class="flex flex-col gap-2">
        <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{connect.addError}</p>
        <div><Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => connect.start()}>Try again</Button></div>
      </div>
    {:else}
      {@render pending(`Adding ${request.name} to ${hostLabel}…`)}
    {/if}
  {:else if step === "oauth-client"}
    <p class="text-workspace-chrome text-(--solus-text-secondary)">{name} has no automatic sign-in setup. Enter the OAuth client you created at the service first.</p>
    <IntegrationOAuthClientForm {serverId} {integration} />
  {:else if flow?.kind === "starting"}
    {@render pending("Starting the sign-in…")}
  {:else if flow?.kind === "waiting"}
    <RowCard>
      <div class="flex items-center gap-2.5 px-4 py-3">
        <LoaderCircle size={16} class="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <span class="text-workspace-chrome text-foreground">{flow.through === "cloud" ? "Authorizing through Solus Cloud" : "Authorizing"}</span>
      </div>
    </RowCard>
    <p class="text-workspace-chrome text-(--solus-text-secondary)">
      Window not showing up?
      <button type="button" class="rounded text-(--solus-accent) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onclick={() => integrationsStore.openSignIn(flow.url)}>Reopen it</button>
    </p>
    {#if flow.input === "redirect-url"}
      {@render pasteForm("Paste the address of the page you landed on", `mcp-connect-redirect-${integration.id}`, "text", flow.error)}
    {/if}
  {:else if flow?.kind === "token"}
    {@render pasteForm(`API key for ${name}`, `mcp-connect-key-${integration.id}`, "password", flow.error)}
  {:else if flow?.kind === "submitting"}
    {@render pending("Finishing sign-in…")}
  {:else}
    {#if integration.auth.kind === "bearer"}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">{name} signs in with an API key. Create one at {urlHost(integration.url)}, then paste it here.</p>
    {:else}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">Authorization happens on {name}’s side. It takes about a minute.</p>
      <RowCard>
        <p class="px-4 py-2.5 text-workspace-chrome text-foreground">A new tab opens at {name}’s sign-in page.</p>
        <p class="px-4 py-2.5 text-workspace-chrome text-foreground">You approve there. {name} asks whether Solus can use your account.</p>
        <p class="px-4 py-2.5 text-workspace-chrome text-foreground">You come back here. Then you choose which tools agents can use.</p>
      </RowCard>
    {/if}
    {#if flow?.kind === "failed"}
      <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{flow.message}</p>
    {:else if connectionProblem}
      <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{connectionProblem.text}{connectionProblem.detail ? `: ${connectionProblem.detail}` : ""}</p>
    {/if}
    <div>
      <Button class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || hostState?.connectionsStatus !== "loaded"} onclick={() => integrationsStore.connect(serverId, integration.id)}>
        {integration.auth.kind === "bearer" ? `Enter an API key` : `Sign in to ${name}`}{#if integration.auth.kind !== "bearer"}<ExternalLink size={14} />{/if}
      </Button>
    </div>
  {/if}
{/snippet}

{#snippet toolsStep()}
  {#if !integration}
    <!-- Not reached: the tools step needs the record. -->
  {:else if toolError}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{toolError}</p>
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.loadTools(serverId, integration.id)}>Retry</Button>
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
    <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{connect.saveError}</p>
  {/if}
  <div class="flex items-center gap-2">
    <Button class="text-workspace-chrome pointer-coarse:min-h-11" disabled={!tools || connect.isSaving || isOffline} onclick={() => connect.finish()}>
      {connect.isSaving ? "Saving…" : `Connect ${name}`}
    </Button>
    <Button variant="outline" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={close}>Cancel</Button>
  </div>
{/snippet}

<!-- The page unmounts the dialog only after its exit animation, so the close is seen. -->
<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) settle(); }} onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(connectedOnClose); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-(--solus-modal-scrim) duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <!-- Centred with margins, not a translate, so the zoom of the animation does not fight the position. -->
    <Dialog.Content
      class="text-workspace-chrome fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] flex-col overflow-y-auto rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      data-testid="mcp-connect-dialog"
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:size-11" aria-label="Close"><X size={16} /></Button>
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
          <Table.Root containerClass="max-h-64 overflow-y-auto" class="table-fixed" aria-label="Tools agents can use">
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
        <div class="mt-4">
          <Button variant="outline" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={close}>Close</Button>
        </div>
        </div>
        </div>
      {:else}
        <div class="flex flex-col gap-1 pr-8">
          <span class="mb-3"><McpServerIcon name={name} url={request.url} icon={request.icon} /></span>
          <Dialog.Title class="font-medium text-foreground">Connect {name}</Dialog.Title>
          <Dialog.Description class="text-(--solus-text-secondary)">
            {tools ? `Your agents get ${tools.length === 1 ? "1 new tool" : `${tools.length} new tools`} once this is connected` : `Its tools reach every agent on ${hostLabel}`}
          </Dialog.Description>
        </div>

        <ol class="mt-6 flex flex-col">
          <li class="flex gap-3">
            <div class="flex flex-col items-center">
              {@render stepMark(1, step === "tools" ? "done" : "current")}
              <span class="my-1 w-px flex-1 border-l border-dashed border-border" aria-hidden="true"></span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3 pb-5">
              <p class="leading-7 {step === 'tools' ? 'text-(--solus-text-secondary)' : 'font-medium text-foreground'}">
                {step === "tools" && !needsSignIn ? "No sign-in needed" : "Sign in"}
              </p>
              {#if step !== "tools"}
                <!-- The sign-in fades out first; the card then shrinks around it. -->
                <div class="flex flex-col gap-3" out:fade={{ duration: motionMs * 0.8 }}>
                  {#key signInView}
                    <div class="flex flex-col gap-3" in:fade={{ duration: motionMs }}>{@render signIn()}</div>
                  {/key}
                </div>
              {/if}
            </div>
          </li>
          <li class="flex gap-3">
            {@render stepMark(2, step === "tools" ? "current" : "next")}
            <div class="flex min-w-0 flex-1 flex-col gap-3">
              <p class="leading-7 {step === 'tools' ? 'font-medium text-foreground' : 'text-muted-foreground'}">Tools</p>
              {#if step === "tools"}
                <!-- The tools rise in after the sign-in has gone. -->
                <div class="flex flex-col gap-3" in:fly={{ y: 8, duration: motionMs * 1.6, delay: motionMs }}>{@render toolsStep()}</div>
              {/if}
            </div>
          </li>
        </ol>
      {/if}
      </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
