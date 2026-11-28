<script lang="ts">
  /**
   * The URL form of Add server (docs/plans/mcp-add-server.md): the address and
   * the name, then Authentication with the fields of each choice. OAuth shows
   * the client, the scopes, and the callback URL to register; Automatic keeps
   * them folded, since they apply only when the server turns out to use OAuth.
   * Headers takes a name and a value for each header. The caller owns the form
   * element and its buttons.
   */
  import { untrack } from "svelte";
  import { Check, ChevronRight, Copy, Plus, X } from "@lucide/svelte";
  import { AUTH_CHOICES, takesOAuthFields } from "@solus/contracts/integrations/auth-choice";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import * as Select from "../ui/select";
  import { copyText } from "../../lib/toasts";
  import type { McpAddressForm } from "./lib/mcp-address-form.svelte";

  interface Props {
    form: McpAddressForm;
    /** The host's OAuth callback URL, for a person who registers their own OAuth app. */
    callbackUrl: string;
    disabled?: boolean;
  }

  let { form, callbackUrl, disabled = false }: Props = $props();

  let isCopied = $state(false);
  /** The OAuth settings of Automatic: folded until opened, or until one is filled or refused. */
  let isOAuthOpen = $state(untrack(() => !!form.clientId || !!form.scopes));
  const choice = $derived(AUTH_CHOICES.find((each) => each.kind === form.authKind) ?? AUTH_CHOICES[0]);
  const showsOAuth = $derived(form.authKind === "oauth" || (takesOAuthFields(form.authKind) && (isOAuthOpen || !!form.problemOf("clientId") || !!form.problemOf("scopes"))));

  function chooseAuth(kind: string) {
    const next = AUTH_CHOICES.find((each) => each.kind === kind);
    if (!next) return;
    form.authKind = next.kind;
    form.problem = null;
  }

  async function copyCallback() {
    await copyText(callbackUrl);
    isCopied = true;
    setTimeout(() => (isCopied = false), 1500);
  }
</script>

{#snippet label(forId: string, text: string)}
  <label for={forId} class="text-workspace-chrome font-medium text-foreground">{text}</label>
{/snippet}

{#snippet hint(id: string, text: string | null, isError: boolean)}
  {#if text}
    <p {id} role={isError ? "alert" : undefined} class="break-words text-chrome-dense {isError ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">{text}</p>
  {/if}
{/snippet}

<div class="flex flex-col gap-3.5">
  <div class="flex flex-col gap-1.5">
    {@render label("mcp-address-url", "URL")}
    <!-- svelte-ignore a11y_autofocus -->
    <Input id="mcp-address-url" type="url" inputmode="url" bind:value={form.address} oninput={() => (form.problem = null)} placeholder="https://mcp.example.com/mcp"
      autocomplete="off" spellcheck={false} dictation={false} {disabled} autofocus aria-invalid={form.problemOf("address") ? true : undefined}
      aria-describedby="mcp-address-url-hint" class="h-8 min-w-0 text-workspace-chrome" />
    {@render hint("mcp-address-url-hint", form.problemOf("address"), true)}
  </div>

  <div class="flex flex-col gap-1.5">
    {@render label("mcp-address-name", "Name")}
    <Input id="mcp-address-name" bind:value={form.name} placeholder={form.suggestedName} autocomplete="off" spellcheck={false} {disabled}
      class="h-8 min-w-0 text-workspace-chrome" />
  </div>

  <div class="flex flex-col gap-1.5">
    <span id="mcp-address-auth-label" class="text-workspace-chrome font-medium text-foreground">Authentication</span>
    <Select.Root type="single" value={form.authKind} onValueChange={chooseAuth} {disabled}>
      <Select.Trigger aria-labelledby="mcp-address-auth-label" aria-describedby="mcp-address-auth-hint" class="w-full text-workspace-chrome">{choice.label}</Select.Trigger>
      <Select.Content class="text-workspace-chrome">
        {#each AUTH_CHOICES as each (each.kind)}
          <Select.Item value={each.kind} label={each.label} />
        {/each}
      </Select.Content>
    </Select.Root>
    {@render hint("mcp-address-auth-hint", choice.description, false)}
  </div>

  {#if form.authKind === "automatic"}
    <button type="button" class="-ml-1 flex min-h-7 w-fit min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1 text-workspace-chrome text-(--solus-text-secondary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      aria-expanded={showsOAuth} aria-controls="mcp-address-oauth" onclick={() => (isOAuthOpen = !showsOAuth)}>
      <ChevronRight size={14} class="shrink-0 transition-transform motion-reduce:transition-none {showsOAuth ? 'rotate-90' : ''}" />
      <span class="truncate">OAuth settings</span>
    </button>
  {/if}

  {#if takesOAuthFields(form.authKind)}
    <!-- Hidden, not unmounted: what was typed stays while the section is closed. -->
    <div id="mcp-address-oauth" class="flex flex-col gap-3.5 {form.authKind === 'automatic' ? 'border-l border-border pl-3.5' : ''} {showsOAuth ? '' : 'hidden'}">
      <div class="flex flex-col gap-1.5">
        {@render label("mcp-address-client-id", "Client ID")}
        <Input id="mcp-address-client-id" bind:value={form.clientId} placeholder="Optional" autocomplete="off" spellcheck={false} dictation={false} {disabled}
          aria-invalid={form.problemOf("clientId") ? true : undefined} aria-describedby="mcp-address-client-hint" class="h-8 min-w-0 text-workspace-chrome" />
      </div>
      <div class="flex flex-col gap-1.5">
        {@render label("mcp-address-client-secret", "Client secret")}
        <Input id="mcp-address-client-secret" type="password" bind:value={form.clientSecret} placeholder="Optional" autocomplete="off" spellcheck={false} dictation={false} {disabled}
          aria-describedby="mcp-address-client-hint" class="h-8 min-w-0 text-workspace-chrome" />
        {@render hint("mcp-address-client-hint", form.problemOf("clientId") ?? "Only for a server that does not register Solus by itself. The secret stays on the host.", !!form.problemOf("clientId"))}
      </div>
      <div class="flex flex-col gap-1.5">
        {@render label("mcp-address-scopes", "Scopes")}
        <Input id="mcp-address-scopes" bind:value={form.scopes} placeholder="Optional, such as read write" autocomplete="off" spellcheck={false} dictation={false} {disabled}
          aria-invalid={form.problemOf("scopes") ? true : undefined} aria-describedby="mcp-address-scopes-hint" class="h-8 min-w-0 text-workspace-chrome" />
        {@render hint("mcp-address-scopes-hint", form.problemOf("scopes") ?? "Separated by spaces. Empty asks for the scopes the server names.", !!form.problemOf("scopes"))}
      </div>
      <div class="flex flex-col gap-1.5">
        <label for="mcp-address-callback" class="text-workspace-chrome font-medium text-foreground">Callback URL</label>
        <div class="flex min-w-0 items-center gap-2">
          <Input id="mcp-address-callback" value={callbackUrl} readonly dictation={false} class="h-8 min-w-0 flex-1 text-workspace-chrome" onfocus={(event) => event.currentTarget.select()} />
          <Button type="button" variant="outline" size="default" class="shrink-0 pointer-coarse:min-h-11" onclick={copyCallback}>
            {#if isCopied}<Check size={14} />Copied{:else}<Copy size={14} />Copy{/if}
          </Button>
        </div>
        {@render hint("mcp-address-callback-hint", "Add it to your OAuth app’s redirect URLs.", false)}
      </div>
    </div>
  {:else if form.authKind === "headers"}
    <div class="flex flex-col gap-2">
      {#each form.headers as header, index (index)}
        <div class="flex min-w-0 items-center gap-2">
          <Input bind:value={header.name} oninput={() => (form.problem = null)} placeholder="X-API-Key" aria-label="Header name {index + 1}"
            autocomplete="off" spellcheck={false} dictation={false} {disabled} aria-invalid={form.problemOf("headers") ? true : undefined} class="h-8 min-w-0 flex-2 text-workspace-chrome" />
          <Input type="password" bind:value={header.value} placeholder="Value" aria-label="Value of header {index + 1}"
            autocomplete="off" spellcheck={false} dictation={false} {disabled} class="h-8 min-w-0 flex-3 text-workspace-chrome" />
          <Button type="button" variant="ghost" size="icon" class="shrink-0 text-muted-foreground hover:text-destructive pointer-coarse:tap-area" {disabled}
            aria-label="Remove header {index + 1}" onclick={() => form.removeHeader(index)}><X size={14} /></Button>
        </div>
      {/each}
      <div>
        <Button type="button" variant="ghost" size="sm" class="-ml-2 text-muted-foreground pointer-coarse:min-h-11" {disabled} onclick={() => form.addHeader()}><Plus size={14} />Add header</Button>
      </div>
      {@render hint("mcp-address-headers-hint", form.problemOf("headers") ?? "Each value is a secret, saved for you alone on this host. Leave a value empty to give it later.", !!form.problemOf("headers"))}
    </div>
  {/if}
</div>
