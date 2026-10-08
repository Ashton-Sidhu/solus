<script lang="ts">
  /**
   * The administrator's OAuth client of a server with no dynamic registration
   * (docs/plans/mcp-integrations.md §4.3). It renders nothing for any other
   * server. The secret stays in this field for one call and is cleared after
   * it; the host never sends it back.
   */
  import { tick } from "svelte";
  import { Check, Copy, LoaderCircle } from "@lucide/svelte";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { copyText } from "../../lib/toasts";
  import { integrationsStore } from "./integrations.store.svelte";
  import { oauthClientText } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    integration: Integration;
  }

  let { serverId, integration }: Props = $props();

  let isEditing = $state(false);
  let isConfirmingRemove = $state(false);
  let clientIdDraft = $state("");
  let secretDraft = $state("");
  let error = $state("");
  let isCopied = $state(false);
  let rootEl = $state<HTMLDivElement | null>(null);

  const hostState = $derived(integrationsStore.states.get(serverId));
  const text = $derived(oauthClientText(integration.auth));
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
    if (text?.state !== "set") return;
    isConfirmingRemove = false;
    error = "";
    clientIdDraft = text.clientId;
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
      {#if text.state === "missing"}
        <p class="text-pretty text-workspace-chrome text-foreground">{text.message}</p>
      {/if}
      <div class="flex flex-col gap-1.5">
        <label for="{fieldPrefix}-redirect" class="text-workspace-chrome font-medium text-foreground">Redirect URL</label>
        <div class="flex flex-wrap items-center gap-2">
          <Input id="{fieldPrefix}-redirect" value={redirectUrl} readonly class="h-8 min-w-0 flex-1 text-workspace-chrome" dictation={false}
            aria-describedby="{fieldPrefix}-redirect-hint" onfocus={(event) => event.currentTarget.select()} />
          <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={copyRedirectUrl} aria-label="Copy the redirect URL">
            {#if isCopied}<Check size={14} />Copied{:else}<Copy size={14} />Copy{/if}
          </Button>
        </div>
        <p id="{fieldPrefix}-redirect-hint" class="text-chrome-dense text-(--solus-text-secondary)">List this address in the OAuth app at the service.</p>
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
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || isOffline || !clientIdDraft.trim()}>
            {#if isBusy}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Saving…{:else}Save{/if}
          </Button>
          {#if isEditing}
            <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={cancelChange} disabled={isBusy}>Cancel</Button>
          {/if}
        </div>
      </form>
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
        <p class="text-pretty text-workspace-chrome">Remove the OAuth client? Nobody can connect to {integration.name} until you enter one again.</p>
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
