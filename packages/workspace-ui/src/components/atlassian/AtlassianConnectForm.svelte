<script lang="ts">
  /**
   * The browser sign-in, shared by the Settings row and the onboarding row so
   * the two can never disagree about what a failure means.
   *
   * No OAuth credential passes through the renderer: the host opens the flow,
   * the browser completes it, and the host announces the result. The fallback
   * is an API token the user pastes; it stays in its field for one call.
   */
  import { tick } from "svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { ATLASSIAN_API_TOKEN_URL } from "@solus/contracts/atlassian";
  import {
    ExternalLink as ArrowSquareOutIcon,
    LoaderCircle as SpinnerGapIcon,
  } from "@lucide/svelte";
  import { atlassianStore, ATLASSIAN_SIGNUP_URL } from "../../contexts/atlassian/atlassian.store.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  interface Props {
    serverId: string;
    /** Fires once the sign-in is connected. */
    onconnected?: () => void;
  }

  let { serverId, onconnected }: Props = $props();

  const failure = $derived(atlassianStore.failure(serverId));
  const fieldPrefix = $derived(`atlassian-token-${serverId}`);
  const oauthAvailable = $derived(atlassianStore.oauthAvailable(serverId));
  const apiTokenAvailable = $derived(atlassianStore.apiTokenAvailable(serverId));

  // With no browser sign-in in this build, the token form is the only way in.
  let usesApiToken = $state(false);
  const showsTokenForm = $derived(apiTokenAvailable && (usesApiToken || !oauthAvailable));
  let siteDraft = $state("");
  let emailDraft = $state("");
  let tokenDraft = $state("");
  let siteInput = $state<HTMLInputElement | null>(null);

  async function chooseApiToken(choice: boolean) {
    usesApiToken = choice;
    atlassianStore.clearFailure(serverId);
    await tick();
    if (choice) siteInput?.focus();
  }

  async function connectApiToken(event: SubmitEvent) {
    event.preventDefault();
    const apiToken = tokenDraft;
    tokenDraft = "";
    const connected = await atlassianStore.connectApiToken(serverId, {
      siteUrl: siteDraft,
      email: emailDraft,
      apiToken,
    });
    if (!connected) tokenDraft = apiToken;
  }

  function onTokenFormKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !oauthAvailable) return;
    event.preventDefault();
    event.stopPropagation();
    void chooseApiToken(false);
  }

  $effect(() => {
    if (atlassianStore.connected(serverId)) onconnected?.();
  });
</script>

<div class="flex flex-col gap-2.5">
  {#if showsTokenForm}
    <form class="flex flex-col gap-2" onsubmit={connectApiToken} onkeydown={onTokenFormKeydown}>
      <div class="flex flex-col gap-1">
        <label for="{fieldPrefix}-site" class="text-xs font-medium text-foreground">Atlassian site</label>
        <Input bind:ref={siteInput} bind:value={siteDraft} id="{fieldPrefix}-site" placeholder="acme.atlassian.net"
          aria-describedby="{fieldPrefix}-site-help" autocomplete="url" spellcheck={false}
          disabled={atlassianStore.connecting(serverId)} class="text-workspace-chrome" />
        <p id="{fieldPrefix}-site-help" class="text-pretty text-xs text-muted-foreground">
          The address in your browser when you open Jira or Confluence. You can paste any link from your site.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <label for="{fieldPrefix}-email" class="text-xs font-medium text-foreground">Email</label>
        <Input bind:value={emailDraft} id="{fieldPrefix}-email" type="email" placeholder="you@example.com"
          aria-describedby="{fieldPrefix}-email-help" autocomplete="email"
          disabled={atlassianStore.connecting(serverId)} class="text-workspace-chrome" />
        <p id="{fieldPrefix}-email-help" class="text-pretty text-xs text-muted-foreground">
          The email you sign in to Atlassian with. It must be the account that made the token.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <label for="{fieldPrefix}-token" class="text-xs font-medium text-foreground">API token</label>
        <Input bind:value={tokenDraft} id="{fieldPrefix}-token" type="password"
          aria-describedby="{fieldPrefix}-token-help" autocomplete="new-password" maxlength={4096}
          disabled={atlassianStore.connecting(serverId)} class="text-workspace-chrome" />
        <p id="{fieldPrefix}-token-help" class="text-pretty text-xs text-muted-foreground">
          Create one at
          <button
            type="button"
            class="-my-2 inline-flex min-h-10 items-center gap-0.5 text-(--solus-accent) underline-offset-2 hover:underline"
            onclick={() => void localApi.openExternal(ATLASSIAN_API_TOKEN_URL)}
          >
            id.atlassian.com → Security → API tokens<ArrowSquareOutIcon size={10} />
          </button>.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={atlassianStore.connecting(serverId) || !siteDraft.trim() || !emailDraft.trim() || !tokenDraft.trim()}>
          {#if atlassianStore.connecting(serverId)}
            <SpinnerGapIcon size={14} class="animate-spin" />
            Checking the token…
          {:else}
            Connect with API token
          {/if}
        </Button>
        {#if oauthAvailable}
          <button
            type="button"
            class="h-7 rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground"
            onclick={() => void chooseApiToken(false)}
          >
            Sign in with a browser instead
          </button>
        {/if}
      </div>
    </form>
  {:else if oauthAvailable}
    <Button
      disabled={atlassianStore.connecting(serverId) || atlassianStore.awaitingBrowser(serverId)}
      onclick={() => void atlassianStore.startOAuth(serverId)}
    >
      {#if atlassianStore.awaitingBrowser(serverId)}
        <SpinnerGapIcon size={14} class="animate-spin" />
        Waiting for your browser…
      {:else}
        Connect with Atlassian
        <ArrowSquareOutIcon size={13} />
      {/if}
    </Button>

    {#if atlassianStore.awaitingBrowser(serverId)}
      <!-- Cancelling has to reach the host: the sign-in holds a fixed loopback
           port while it waits, and leaving it bound blocks the next attempt. -->
      <button
        type="button"
        class="h-7 self-start rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground"
        onclick={() => void atlassianStore.cancelBrowserWait(serverId)}
      >
        Cancel
      </button>
    {:else if apiTokenAvailable}
      <button
        type="button"
        class="h-7 self-start rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground"
        onclick={() => void chooseApiToken(true)}
      >
        Use an API token instead
      </button>
    {/if}
  {:else}
    <p class="text-pretty text-xs text-muted-foreground">
      This build of Solus ships no Atlassian sign-in, so it cannot connect to
      Confluence or Jira.
    </p>
  {/if}

  {#if failure}
    <p
      class="cursor-text select-text text-pretty text-xs text-(--solus-status-error)"
      role="alert"
    >
      {failure.message}
    </p>
  {/if}

  {#if showsTokenForm}
    <div
      class="rounded-lg bg-muted px-3 py-2.5 text-pretty text-xs leading-[1.55] text-muted-foreground"
    >
      <p class="font-medium text-foreground">About API tokens</p>
      <p class="mt-0.5">
        The token acts as you, with all your Confluence and Jira access. Solus
        keeps it on this host only. You can revoke it from your Atlassian
        account at any time.
      </p>
    </div>
  {:else if oauthAvailable}
    <div
      class="rounded-lg bg-muted px-3 py-2.5 text-pretty text-xs leading-[1.55] text-muted-foreground"
    >
      <p class="font-medium text-foreground">What Solus will ask for</p>
      <p class="mt-0.5">
        Read and write access to Confluence pages and Jira issues on one
        Atlassian site, acting as you. Atlassian shows the exact list before you
        approve, and you can revoke it from your Atlassian account at any time.
      </p>
      <p class="mt-2.5 border-t border-border/60 pt-2">
        No Atlassian site?
        <button
          type="button"
          class="-my-2 inline-flex min-h-10 items-center gap-0.5 text-(--solus-accent) underline-offset-2 hover:underline"
          onclick={() => void localApi.openExternal(ATLASSIAN_SIGNUP_URL)}
        >
          Create one free<ArrowSquareOutIcon size={10} />
        </button>
      </p>
    </div>
  {/if}
</div>
