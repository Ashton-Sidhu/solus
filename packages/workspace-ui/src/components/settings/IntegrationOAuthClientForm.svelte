<script lang="ts">
  /**
   * The owner's optional OAuth client (docs/plans/mcp-integrations.md §4.3).
   * The secret stays in this field for one call and is cleared after it;
   * the host never sends it back.
   *
   * `compact` is the connect card's form: one line of direction and the
   * card's own buttons.
   */
  import { tick } from "svelte";
  import { Check, Copy, LoaderCircle } from "@lucide/svelte";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { copyText } from "../../lib/toasts";
  import { integrationsStore } from "./integrations.store.svelte";
  import { IntegrationLabels } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    integration: Integration;
    compact?: boolean;
  }

  let { serverId, integration, compact = false }: Props = $props();

  let isEditing = $state(false);
  let isConfirmingRemove = $state(false);
  let clientIdDraft = $state("");
  let secretDraft = $state("");
  let error = $state("");
  let isCopied = $state(false);
  let rootEl = $state<HTMLDivElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const text = $derived(new IntegrationLabels(integration).clientText);
  const isBusy = $derived(!!hostState?.saving);
  const isOffline = $derived(!!hostState?.isDisconnected);
  const showForm = $derived(text?.state === "missing" || isEditing);
  const redirectUrl = $derived(integrationsStore.oauthRedirectUrl(serverId));
  const fieldPrefix = $derived(`integration-oauth-${integration.id}`);

  async function focusFirstControl() {
    await tick();
    rootEl?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }

  /** The write's error belongs to this form, not to the Add section below. */
  function keepWriteError() {
    error = hostState?.writeError ?? "";
    integrationsStore.clearWriteError(serverId);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const clientId = clientIdDraft.trim();
    if (!clientId) return;
    const clientSecret = secretDraft;
    secretDraft = "";
    error = "";
    const saved = await integrationsStore.setOAuthClient(serverId, integration.id, clientSecret ? { clientId, clientSecret } : { clientId });
    if (saved) isEditing = false;
    else { secretDraft = clientSecret; keepWriteError(); }
    await focusFirstControl();
  }

  async function remove() {
    error = "";
    if (await integrationsStore.setOAuthClient(serverId, integration.id, null)) {
      isConfirmingRemove = false;
      clientIdDraft = "";
    } else keepWriteError();
    await focusFirstControl();
  }

  function startChange() {
    if (!text) return;
    isConfirmingRemove = false;
    error = "";
    clientIdDraft = text.state === "set" ? text.clientId : "";
    secretDraft = "";
    isEditing = true;
    void focusFirstControl();
  }

  function cancelChange() {
    isEditing = false;
    secretDraft = "";
    error = "";
    void focusFirstControl();
  }

  async function copyRedirectUrl() {
    await copyText(redirectUrl);
    isCopied = true;
    setTimeout(() => (isCopied = false), 1500);
  }

  function onFieldKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !isEditing) return;
    event.preventDefault();
    event.stopPropagation();
    cancelChange();
  }
</script>

{#if text}
  <div bind:this={rootEl} class="flex flex-col gap-2.5" data-testid="integration-oauth-client">
    {#if showForm}
      {#if compact}
        <p class="text-pretty text-workspace-chrome text-muted-foreground">Create an OAuth app at {integration.name} with this redirect URL, then enter its client.</p>
      {:else}
        <p class="text-pretty text-workspace-chrome text-(--solus-text-secondary)">Create an OAuth app at {integration.name} with this redirect URL, then enter its client ID.</p>
      {/if}
      <div class="flex flex-col gap-1.5">
        <label for="{fieldPrefix}-redirect" class="text-workspace-chrome font-medium text-foreground">Redirect URL</label>
        {#if compact}
          <!-- The copy icon sits inside the field, so the row has no button of its own. -->
          <div class="relative">
            <Input id="{fieldPrefix}-redirect" value={redirectUrl} readonly class="h-8 w-full min-w-0 pr-9 text-workspace-chrome" dictation={false}
              onfocus={(event) => event.currentTarget.select()} />
            <TranscriptCardAction kind="icon" class="absolute inset-y-0 right-1 my-auto" label={isCopied ? "Copied" : "Copy the redirect URL"} onclick={copyRedirectUrl}>
              {#if isCopied}<Check size={14} aria-hidden="true" />{:else}<Copy size={14} aria-hidden="true" />{/if}
            </TranscriptCardAction>
          </div>
        {:else}
          <div class="flex flex-wrap items-center gap-2">
            <Input id="{fieldPrefix}-redirect" value={redirectUrl} readonly class="h-8 min-w-0 flex-1 text-workspace-chrome" dictation={false}
              onfocus={(event) => event.currentTarget.select()} />
            <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={copyRedirectUrl} aria-label="Copy the redirect URL">
              {#if isCopied}<Check size={14} />Copied{:else}<Copy size={14} />Copy{/if}
            </Button>
          </div>
        {/if}
      </div>
      <form class="flex flex-col gap-2.5" onsubmit={save}>
        <div class="flex flex-col gap-1.5">
          <label for="{fieldPrefix}-id" class="text-workspace-chrome font-medium text-foreground">Client ID</label>
          <Input id="{fieldPrefix}-id" bind:value={clientIdDraft} class="h-8 min-w-0 text-workspace-chrome" autocomplete="off" spellcheck={false} dictation={false}
            disabled={isBusy || isOffline} onkeydown={onFieldKeydown} />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="{fieldPrefix}-secret" class="text-workspace-chrome font-medium text-foreground">Client secret <span class="font-normal text-muted-foreground">(optional)</span></label>
          <Input id="{fieldPrefix}-secret" type="password" bind:value={secretDraft} class="h-8 min-w-0 text-workspace-chrome" autocomplete="off" spellcheck={false} dictation={false}
            disabled={isBusy || isOffline} onkeydown={onFieldKeydown} aria-describedby={text.state === "set" && text.changeHint ? `${fieldPrefix}-secret-hint` : undefined} />
          {#if text.state === "set" && text.changeHint}
            <p id="{fieldPrefix}-secret-hint" class="text-chrome-dense text-(--solus-text-secondary)">{text.changeHint}</p>
          {/if}
        </div>
        <div class="flex flex-wrap items-center gap-2 {compact ? 'justify-end' : ''}">
          {#if compact}
            <TranscriptCardAction kind="filled" type="submit" disabled={isBusy || isOffline || !clientIdDraft.trim()}>
              {#if isBusy}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />Saving…{:else}Save{/if}
            </TranscriptCardAction>
          {:else}
            <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || isOffline || !clientIdDraft.trim()}>
              {#if isBusy}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Saving…{:else}Save{/if}
            </Button>
          {/if}
          {#if isEditing}
            <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={cancelChange} disabled={isBusy}>Cancel</Button>
          {/if}
        </div>
      </form>
    {:else if text.state === "automatic"}
      <div><Button variant="link" size="sm" class="h-auto p-0 text-chrome-dense text-muted-foreground hover:text-foreground pointer-coarse:min-h-11" onclick={startChange} disabled={isBusy || isOffline}>{text.message}</Button></div>
    {:else if text.state === "set"}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-workspace-chrome text-foreground">{text.message}</p>
          <p class="truncate text-chrome-dense text-(--solus-text-secondary)" title={text.clientId}>
            {text.clientId} · {text.secret}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={startChange} disabled={isBusy || isOffline}>Change</Button>
          <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground hover:text-destructive pointer-coarse:min-h-11" onclick={() => { error = ""; isConfirmingRemove = true; }}
            disabled={isBusy || isOffline} aria-label="Remove the OAuth client of {integration.name}">Remove</Button>
        </div>
      </div>
      {#if isConfirmingRemove}
        <p class="text-pretty text-workspace-chrome">Remove the OAuth client? {integration.auth.kind === "oauth" && integration.auth.registration !== "client-required" ? "New sign-ins will use automatic setup again." : "Enter another client before you sign in again."}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="destructive" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={remove} disabled={isBusy}>{isBusy ? "Removing…" : "Remove client"}</Button>
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { isConfirmingRemove = false; void focusFirstControl(); }} disabled={isBusy}>Cancel</Button>
        </div>
      {/if}
    {/if}
    {#if error}
      <p role="alert" class="break-words text-workspace-chrome text-(--solus-status-error)">{error}</p>
    {/if}
  </div>
{/if}
