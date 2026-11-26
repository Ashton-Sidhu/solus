<script lang="ts">
  /** "Use Solus in other apps" on a host's Access tab (plans/035 §10): the
   *  host's MCP address, the Claude Code command that adds it, and a one-time
   *  pairing code for an app's sign-in page. The apps that signed in are in
   *  the paired devices list, with their access and Revoke. */
  import { untrack } from "svelte";
  import { Check as CheckIcon, Copy as CopyIcon, KeyRound as KeyIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { pairingLock } from "../settings/policy/managed-setting.svelte";
  import { appEndpointAddresses, claudeMcpAddCommand, pairingCodeExpiry } from "./lib/outside-apps";
  import { outsideAppsRequest } from "./lib/access-tab-requests.svelte";

  interface Props {
    serverId: string;
    /** This client may make a pairing code on the host (host.local.reach). */
    canMakeCode: boolean;
  }

  let { serverId, canMakeCode }: Props = $props();

  const connections = connectionsStore;
  let copiedField = $state<string | null>(null);
  let addressesElement = $state<HTMLElement | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    const hostId = serverId;
    untrack(() => void connections.loadAppEndpoint(hostId));
  });

  // The palette's "Use Solus in other apps" brings this section into view once.
  $effect(() => {
    if (outsideAppsRequest.serverId !== serverId || !addressesElement) return;
    const element = addressesElement;
    untrack(() => {
      if (!outsideAppsRequest.take(serverId)) return;
      element.scrollIntoView({ block: "center" });
      element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
  });

  $effect(() => {
    if (!connections.appPairingCode) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const endpoint = $derived(connections.appEndpoint);
  const addresses = $derived(endpoint ? appEndpointAddresses(endpoint) : []);
  const command = $derived(endpoint ? claudeMcpAddCommand(endpoint) : "");
  const code = $derived(connections.appPairingCode);
  const codeExpired = $derived(code ? code.expiresAt <= now : false);
  const pairingLocked = $derived(pairingLock(serverId));

  function copy(value: string, field: string) {
    void navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout(() => {
      if (copiedField === field) copiedField = null;
    }, 1500);
  }
</script>

<SettingsSection
  label="Use Solus in other apps"
  description="Claude Desktop, Cursor, Claude Code, and other MCP apps can use this host's tools. The app opens a sign-in page, where you approve it in Solus or type a pairing code."
>
  {#if connections.appEndpointError}
    <p role="alert" class="px-4 py-3.5 text-workspace-chrome text-(--solus-status-error)">{connections.appEndpointError}</p>
  {:else if !endpoint}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">Reading the MCP address…</p>
  {:else}
    <div bind:this={addressesElement} class="flex flex-col gap-2 px-4 py-3.5">
      <p class="text-workspace-chrome font-medium text-(--solus-text-primary)">MCP address</p>
      {#each addresses as address (address.kind)}
        <div class="flex min-w-0 flex-col gap-1">
          <span class="text-chrome-dense text-(--solus-text-secondary)">{address.label}</span>
          <div class="flex min-w-0 items-center gap-2 rounded-lg bg-(--solus-surface-hover) py-1.5 pr-1.5 pl-2.5">
            <code class="min-w-0 flex-1 truncate font-mono text-chrome-dense text-(--solus-text-primary)">{address.url}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-(--solus-text-tertiary)"
              onclick={() => copy(address.url, address.kind)}
              aria-label={`Copy the MCP address ${address.label.toLowerCase()}`}
            >
              {#if copiedField === address.kind}
                <CheckIcon size={13} class="text-(--solus-status-complete)" />
              {:else}
                <CopyIcon size={13} />
              {/if}
            </Button>
          </div>
        </div>
      {/each}
      {#if !endpoint.publicUrl}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">Apps on other computers and cloud apps need a public address. Link this host to Solus Cloud to get one.</p>
      {/if}
    </div>

    <SettingsRow label="Claude Code" description="Run this command, then run claude mcp login solus to sign in.">
      {#snippet body()}
        <div class="flex min-w-0 items-center gap-2 rounded-lg bg-(--solus-surface-hover) py-1.5 pr-1.5 pl-2.5">
          <code class="min-w-0 flex-1 truncate font-mono text-chrome-dense text-(--solus-text-primary)">{command}</code>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-(--solus-text-tertiary)"
            onclick={() => copy(command, "command")}
            aria-label="Copy the Claude Code command"
          >
            {#if copiedField === "command"}
              <CheckIcon size={13} class="text-(--solus-status-complete)" />
            {:else}
              <CopyIcon size={13} />
            {/if}
          </Button>
        </div>
      {/snippet}
    </SettingsRow>
  {/if}

  {#if canMakeCode}
    <SettingsRow
      label="Pairing code"
      description="Type it on the app's sign-in page to approve the app. It works once, for 10 minutes."
      managed={pairingLocked}
      bodyVisible={!!code || !!connections.appPairingCodeError}
    >
      {#snippet control()}
        <Button
          variant="outline"
          size="sm"
          disabled={connections.appPairingCodeCreating}
          onclick={() => void connections.createAppPairingCode(serverId)}
        >
          <KeyIcon size={14} />
          {code ? "Make new code" : "Make pairing code"}
        </Button>
      {/snippet}
      {#snippet body()}
        {#if connections.appPairingCodeError}
          <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{connections.appPairingCodeError}</p>
        {:else if code}
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code class={["font-mono text-[1.5em] font-medium tabular-nums text-(--solus-text-primary)", codeExpired && "opacity-40"]}>{code.code}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-(--solus-text-tertiary)"
              disabled={codeExpired}
              onclick={() => copy(code.code, "code")}
              aria-label="Copy the pairing code"
            >
              {#if copiedField === "code"}
                <CheckIcon size={13} class="text-(--solus-status-complete)" />
              {:else}
                <CopyIcon size={13} />
              {/if}
            </Button>
            <span class={["text-chrome-dense tabular-nums", codeExpired ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)"]}>
              {pairingCodeExpiry(code.expiresAt, now)}
            </span>
          </div>
        {/if}
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
