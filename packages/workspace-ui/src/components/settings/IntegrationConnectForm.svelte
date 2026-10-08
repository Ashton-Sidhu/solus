<script lang="ts">
  /**
   * The caller's own connection to one integration, and the sign-in that changes
   * it (docs/plans/mcp-integrations.md §4). Shared by the Settings row and the
   * conversation's connect card, so the two never disagree about a flow: the
   * flow lives in `integrationsStore`, and only the typed value lives here.
   *
   * A pasted API key stays in this field for one call and is cleared after it.
   */
  import { tick, untrack } from "svelte";
  import { ExternalLink, LoaderCircle } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { integrationsStore } from "./integrations.store.svelte";
  import { connectionStatusText, oauthClientText } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    integrationId: string;
    integrationName: string;
  }

  let { serverId, integrationId, integrationName }: Props = $props();

  let value = $state("");
  let rootEl = $state<HTMLDivElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const connection = $derived(hostState?.connections.get(integrationId) ?? null);
  const flow = $derived(hostState?.connectFlows.get(integrationId) ?? null);
  const status = $derived(connectionStatusText(connection));
  const isOffline = $derived(!!hostState?.isDisconnected);
  const integration = $derived(hostState?.integrations?.find((item) => item.id === integrationId) ?? null);
  const clientText = $derived(integration ? oauthClientText(integration.auth) : null);
  /** A server with no dynamic registration cannot start a sign-in until an administrator enters its client. */
  const connectHint = $derived(status.action !== "Disconnect" && clientText?.state === "missing" ? clientText.connectHint : null);
  const showAction = $derived(hostState?.connectionsStatus === "loaded" && (!flow || flow.kind === "failed"));

  // The card can stand before any Settings page has read this host.
  $effect(() => {
    const hostId = serverId;
    return untrack(() => integrationsStore.watch(hostId));
  });

  /** After an action, the caret goes to the next control the person needs. */
  async function focusNextControl() {
    await tick();
    rootEl?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }

  async function runAction() {
    if (status.action === "Disconnect") await integrationsStore.disconnect(serverId, integrationId);
    else await integrationsStore.connect(serverId, integrationId);
    await focusNextControl();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const submitted = value;
    value = "";
    if (!(await integrationsStore.submit(serverId, integrationId, submitted))) value = submitted;
    await focusNextControl();
  }

  function cancel() {
    value = "";
    void integrationsStore.cancel(serverId, integrationId);
    void focusNextControl();
  }

  function onFieldKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
</script>

{#snippet pending(text: string)}
  <p role="status" class="flex items-center gap-2 text-workspace-chrome text-muted-foreground">
    <LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />{text}
  </p>
{/snippet}

{#snippet fieldForm(label: string, fieldId: string, type: "text" | "password", error: string | undefined)}
  <form class="flex flex-col gap-1.5" onsubmit={submit}>
    <label for={fieldId} class="text-workspace-chrome font-medium text-foreground">{label}</label>
    <div class="flex flex-wrap items-center gap-2">
      <Input id={fieldId} {type} bind:value class="h-8 min-w-0 flex-1 text-workspace-chrome" autocomplete="off" spellcheck={false} dictation={false}
        disabled={isOffline} aria-invalid={error ? true : undefined} aria-describedby={error ? `${fieldId}-error` : undefined} onkeydown={onFieldKeydown} />
      <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || !value.trim()}>Submit</Button>
      <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={cancel}>Cancel</Button>
    </div>
    {#if error}
      <p id="{fieldId}-error" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{error}</p>
    {/if}
  </form>
{/snippet}

<div bind:this={rootEl} class="flex flex-col gap-2.5" data-testid="integration-connection">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="min-w-0 flex-1">
      {#if !hostState || hostState.connectionsStatus === "loading"}
        {@render pending("Checking your connection…")}
      {:else if hostState.connectionsStatus === "unsupported"}
        <p class="text-workspace-chrome text-muted-foreground">Update this host to sign in to {integrationName}.</p>
      {:else if hostState.connectionsStatus === "error"}
        <div class="flex flex-wrap items-center gap-2">
          <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">Could not read your connection.</p>
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.loadConnections(serverId)} disabled={isOffline}>Retry</Button>
        </div>
      {:else}
        <p class="truncate text-workspace-chrome {connection && connection.status !== 'connected' ? 'text-(--solus-status-error)' : 'text-foreground'}" title={status.text}>{status.text}</p>
        {#if status.detail}
          <p class="break-words text-chrome-dense text-(--solus-text-secondary)">{status.detail}</p>
        {/if}
      {/if}
    </div>
    {#if showAction}
      <Button variant={status.action === "Disconnect" ? "ghost" : "outline"} size="sm"
        class="text-workspace-chrome pointer-coarse:min-h-11 {status.action === 'Disconnect' ? 'text-muted-foreground hover:text-destructive' : ''}"
        aria-label="{status.action} {integrationName}" aria-describedby={connectHint ? `integration-connect-hint-${integrationId}` : undefined}
        disabled={isOffline || !!connectHint} onclick={runAction}>{status.action}</Button>
    {/if}
  </div>
  {#if showAction && connectHint}
    <p id="integration-connect-hint-{integrationId}" class="text-chrome-dense text-(--solus-text-secondary)">{connectHint}</p>
  {/if}

  {#if flow?.kind === "starting"}
    {@render pending("Starting the sign-in…")}
  {:else if flow?.kind === "waiting"}
    <div class="flex flex-wrap items-center gap-2">
      <p class="min-w-0 flex-1 text-workspace-chrome text-muted-foreground">Finish signing in in your browser</p>
      <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => integrationsStore.openSignIn(flow.url)}>
        Open sign-in<ExternalLink size={14} />
      </Button>
      {#if flow.input === "callback"}
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={cancel}>Cancel</Button>
      {/if}
    </div>
    {#if flow.input === "redirect-url"}
      {@render fieldForm("Paste the address of the page you landed on", `integration-redirect-${integrationId}`, "text", flow.error)}
    {/if}
  {:else if flow?.kind === "token"}
    {@render fieldForm("API key", `integration-key-${integrationId}`, "password", flow.error)}
  {:else if flow?.kind === "submitting"}
    <div class="flex flex-wrap items-center gap-2">
      <div class="min-w-0 flex-1">{@render pending("Finishing sign-in…")}</div>
      {#if flow.flowId}
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={cancel}>Cancel</Button>
      {/if}
    </div>
  {:else if flow?.kind === "disconnecting"}
    {@render pending("Disconnecting…")}
  {:else if flow?.kind === "failed"}
    <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{flow.message}</p>
  {/if}
</div>
