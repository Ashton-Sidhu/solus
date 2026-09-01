<script lang="ts">
  import { localApi } from "@client-core/local-api";
  /**
   * The paste-a-token step, shared by the Settings row and the in-conversation
   * ConnectCard so the two can never disagree about what a failure means.
   *
   * The token lives in this component's field and nowhere else — it is handed to
   * the store for the duration of one call and cleared the moment that call
   * succeeds. It is never stored, never logged, never rendered back.
   */
  import { tick } from "svelte";
  import { ArrowSquareOutIcon, SpinnerGapIcon } from "phosphor-svelte";
  import {
    cloudflareStore,
    CLOUDFLARE_SIGNUP_URL,
    CLOUDFLARE_TOKEN_PERMISSIONS,
    CLOUDFLARE_TOKEN_URL,
  } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  interface Props {
    /** Puts the caret in the token field as the form appears. */
    autofocus?: boolean;
    /** Fires once the profile is connected, after the field has been cleared. */
    onconnected?: () => void;
  }

  let { autofocus = false, onconnected }: Props = $props();

  let token = $state("");
  let manualAccountId = $state("");
  let tokenRef = $state<HTMLInputElement | null>(null);
  let accountIdRef = $state<HTMLInputElement | null>(null);
  let accountPickerEl = $state<HTMLDivElement | null>(null);

  const failure = $derived(cloudflareStore.failure);
  const canSubmit = $derived(
    token.trim().length > 0 && !cloudflareStore.connecting,
  );

  // A retry carries the token the user already pasted; only the account arm
  // changes. Neither account failure makes anyone re-type the secret.
  async function submit(accountId?: string) {
    const apiToken = token.trim();
    if (!apiToken || cloudflareStore.connecting) return;
    const connected = await cloudflareStore.connect(apiToken, accountId);
    if (connected) {
      token = "";
      manualAccountId = "";
      onconnected?.();
      return;
    }
    // Land the caret on whatever the failure asks for next, rather than on a
    // generic start-over.
    await tick();
    const kind = cloudflareStore.failure?.kind;
    if (kind === "choose-account")
      accountPickerEl?.querySelector("button")?.focus();
    else if (kind === "accounts-forbidden") accountIdRef?.focus();
    else tokenRef?.focus();
  }

  function submitOnEnter(event: KeyboardEvent, accountId?: string) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit(accountId);
  }
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex flex-col gap-2 sm:flex-row">
    <Input
      bind:ref={tokenRef}
      bind:value={token}
      {autofocus}
      type="password"
      autocomplete="off"
      spellcheck={false}
      placeholder="Paste your Cloudflare API token"
      aria-label="Cloudflare API token"
      onkeydown={(event) => submitOnEnter(event)}
      oninput={() => cloudflareStore.clearFailure()}
    />
    <Button class="shrink-0" disabled={!canSubmit} onclick={() => void submit()}>
      {#if cloudflareStore.connecting}
        <SpinnerGapIcon size={14} class="animate-spin" />
        Verifying…
      {:else}
        Connect
      {/if}
    </Button>
  </div>

  {#if failure?.kind === "choose-account"}
    <div class="flex flex-col gap-1.5">
      <span class="text-xs text-muted-foreground">{failure.message}</span>
      <div class="flex flex-wrap gap-1.5" bind:this={accountPickerEl}>
        {#each failure.accounts as account (account.id)}
          <Button
            variant="outline"
            size="sm"
            disabled={cloudflareStore.connecting}
            onclick={() => void submit(account.id)}
          >
            {account.name}
          </Button>
        {/each}
      </div>
    </div>
  {:else if failure?.kind === "accounts-forbidden"}
    <div class="flex flex-col gap-1.5">
      <span class="text-xs text-muted-foreground">{failure.message}</span>
      <div class="flex flex-col gap-2 sm:flex-row">
        <Input
          bind:ref={accountIdRef}
          bind:value={manualAccountId}
          dictation={false}
          autocomplete="off"
          spellcheck={false}
          placeholder="Account ID"
          aria-label="Cloudflare account ID"
          onkeydown={(event) => submitOnEnter(event, manualAccountId.trim())}
        />
        <Button
          class="shrink-0"
          variant="outline"
          disabled={!manualAccountId.trim() || cloudflareStore.connecting}
          onclick={() => void submit(manualAccountId.trim())}
        >
          Use this account
        </Button>
      </div>
    </div>
  {:else if failure}
    <p
      class="cursor-text select-text text-pretty text-xs text-(--solus-status-error)"
      role="alert"
    >
      {failure.message}
    </p>
  {/if}

  <div
    class="rounded-lg bg-muted px-3 py-2.5 text-pretty text-xs leading-[1.55] text-muted-foreground"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="font-medium text-foreground">Create a custom API token</p>
        <p class="mt-0.5">
          Use a scoped API token—not your Global API Key—and configure it as
          follows before pasting it above.
        </p>
      </div>
      <button
        type="button"
        class="-my-2 inline-flex min-h-10 shrink-0 items-center gap-1 text-(--solus-accent) underline-offset-2 hover:underline"
        onclick={() => void localApi.openExternal(CLOUDFLARE_TOKEN_URL)}
      >
        Open API Tokens<ArrowSquareOutIcon size={10} />
      </button>
    </div>

    <ol
      class="mt-2.5 list-decimal space-y-2 pl-4 marker:font-medium marker:text-foreground"
    >
      <li>
        Select <strong class="font-medium text-foreground">Create Token</strong>,
        then choose
        <strong class="font-medium text-foreground">Create Custom Token</strong>.
      </li>
      <li>
        Add these
        <strong class="font-medium text-foreground">Account</strong> permissions:
        <ul class="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {#each CLOUDFLARE_TOKEN_PERMISSIONS as permission (permission.permission)}
            <li
              class="flex items-baseline justify-between gap-2 border-b border-border/60 py-0.5 last:border-b-0"
            >
              <span>{permission.permission}</span>
              <strong class="shrink-0 font-medium text-foreground"
                >{permission.access}</strong
              >
            </li>
          {/each}
        </ul>
      </li>
      <li>
        Under
        <strong class="font-medium text-foreground">Account Resources</strong>,
        choose <strong class="font-medium text-foreground">Include</strong> and
        select the account Solus should deploy to. No Zone or User permissions
        are required.
      </li>
      <li>
        Continue to the summary, create the token, and copy it. Cloudflare shows
        the token only once.
      </li>
    </ol>

    <p class="mt-2.5 border-t border-border/60 pt-2">
      No Cloudflare account?
      <button
        type="button"
        class="-my-2 inline-flex min-h-10 items-center gap-0.5 text-(--solus-accent) underline-offset-2 hover:underline"
        onclick={() => void localApi.openExternal(CLOUDFLARE_SIGNUP_URL)}
      >
        Sign up free<ArrowSquareOutIcon size={10} />
      </button>
    </p>
  </div>
</div>
