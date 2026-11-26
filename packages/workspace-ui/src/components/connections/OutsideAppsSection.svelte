<script lang="ts">
  /** "Use Solus in other apps" on a host's Access tab (plans/035 §10): the apps
   *  a person picks from, each with how to set it up; the host's MCP address;
   *  the Claude Code command that adds it; and a one-time pairing code for an
   *  app's sign-in page. Every person who uses the host sees it, and an app they
   *  approve acts as them. The apps that signed in are in the paired devices
   *  list, with their access and Revoke. */
  import { untrack } from "svelte";
  import {
    AppWindow as AppWindowIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    ExternalLink as ExternalLinkIcon,
    KeyRound as KeyIcon,
    SquareTerminal as TerminalIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { LOCAL_POLICY_ORGANIZATION_ID } from "@solus/contracts/policy";
  import { connectionsStore } from "../../contexts";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { policiesOn, workPolicy } from "../../contexts/policy/work-policy.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import {
    appEndpointAddresses,
    claudeMcpAddCommand,
    openOutsideApp,
    outsideAppAction,
    outsideAppAddress,
    outsideAppChoices,
    outsideAppFallbackLink,
    pairingCodeExpiry,
    type LinkOpener,
    type OutsideAppAction,
  } from "./lib/outside-apps";
  import { outsideAppsRequest } from "./lib/access-tab-requests.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const connections = connectionsStore;
  let copiedField = $state<string | null>(null);
  let pickerElement = $state<HTMLElement | null>(null);
  let now = $state(Date.now());
  let selectedGuideId = $state<string | null>(null);
  /** What the last handoff did: the copy line, a page to open when the client cannot know the app opened, or why it failed. */
  let handoff = $state<{ guideId: string; note: string | null; fallbackLink: string | null; error: string | null } | null>(null);

  const opener: LinkOpener = {
    isWeb: localApi.getPlatform() === "web",
    openExternal: (url) => localApi.openExternal(url),
    assign: (url) => window.location.assign(url),
  };

  $effect(() => {
    const hostId = serverId;
    untrack(() => {
      selectedGuideId = null;
      handoff = null;
      void connections.loadAppEndpoint(hostId);
    });
  });

  // The palette's "Use Solus in other apps" brings this section into view once.
  $effect(() => {
    if (outsideAppsRequest.serverId !== serverId || !pickerElement) return;
    const element = pickerElement;
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
  // The host checks an app against the policy of the person who approves it:
  // a member's organization, or the owner's personal work (plans/035 §10).
  const appPolicy = $derived(
    hosts.get(serverId).me.principal === "org-member"
      ? workPolicy(serverId)
      : policiesOn(serverId).forWork(LOCAL_POLICY_ORGANIZATION_ID),
  );
  const choices = $derived(outsideAppChoices(appPolicy));
  const selected = $derived(choices.find((choice) => choice.guide.id === selectedGuideId) ?? null);
  const selectedAddress = $derived(selected && endpoint ? outsideAppAddress(selected.guide, endpoint) : null);
  const selectedAction = $derived(selected && selectedAddress ? outsideAppAction(selected.guide, selectedAddress) : null);
  const selectedHandoff = $derived(handoff && handoff.guideId === selectedGuideId ? handoff : null);

  function copy(value: string, field: string) {
    void navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout(() => {
      if (copiedField === field) copiedField = null;
    }, 1500);
  }

  function pick(guideId: string) {
    selectedGuideId = selectedGuideId === guideId ? null : guideId;
    handoff = null;
  }

  async function handOff(guideId: string, name: string, action: Extract<OutsideAppAction, { kind: "open" }>) {
    if (action.copy) {
      // The app opens only once the copy lands, so it never reads an older clipboard.
      const copied = await navigator.clipboard.writeText(action.copy.text).then(() => true, () => false);
      if (!copied) {
        handoff = { guideId, note: null, fallbackLink: null, error: "Solus could not copy. Use the steps below." };
        return;
      }
    }
    const opened = await openOutsideApp(action, opener);
    handoff = {
      guideId,
      note: action.copy?.done ?? null,
      fallbackLink: outsideAppFallbackLink(action, opener.isWeb),
      error: opened ? null : `Solus could not open ${name}. Use the steps below.`,
    };
  }
</script>

<SettingsSection
  label="Use Solus in other apps"
  description="Claude, ChatGPT, Cursor, Claude Code, and other MCP apps can use this host's tools as you. The app opens a sign-in page, where you approve it in Solus or type a pairing code."
>
  {#if connections.appEndpointError}
    <p role="alert" class="px-4 py-3.5 text-workspace-chrome text-(--solus-status-error)">{connections.appEndpointError}</p>
  {:else if !endpoint}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">Reading the MCP address…</p>
  {:else}
    <div bind:this={pickerElement} class="flex flex-col gap-3 px-4 py-3.5">
      <p id="outside-apps-picker-{serverId}" class="text-workspace-chrome font-medium text-(--solus-text-primary)">Choose an app</p>
      <div role="group" aria-labelledby="outside-apps-picker-{serverId}" class="grid grid-cols-2 gap-2 @min-[30rem]/pane:grid-cols-4">
        {#each choices as choice (choice.guide.id)}
          {@const AppIcon = choice.guide.handoff.kind === "commands" ? TerminalIcon : AppWindowIcon}
          {@const isSelected = choice.guide.id === selectedGuideId}
          <button
            type="button"
            aria-pressed={isSelected}
            onclick={() => pick(choice.guide.id)}
            class={[
              "flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11",
              isSelected ? "border-(--solus-text-tertiary) bg-(--solus-surface-active)" : "border-border hover:bg-(--solus-surface-hover)",
            ]}
          >
            <AppIcon size={16} class={["shrink-0", choice.denial ? "text-(--solus-text-tertiary)" : "text-foreground"]} />
            <span class="flex min-w-0 flex-col">
              <span class={["truncate text-workspace-chrome", choice.denial ? "text-(--solus-text-tertiary)" : "text-(--solus-text-primary)"]}>{choice.guide.name}</span>
              {#if choice.denial}
                <span class="truncate text-chrome-dense text-(--solus-text-tertiary)">Not allowed</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>

      {#if selected}
        <div class="flex flex-col gap-2.5 rounded-lg border border-border p-3" aria-live="polite">
          {#if selected.denial}
            <p class="text-workspace-chrome text-(--solus-text-secondary)">{selected.denial}</p>
          {:else if !selectedAction}
            <p class="text-workspace-chrome text-(--solus-text-secondary)">{selected.guide.name} runs in the cloud, so it needs a host with a public address. Link this host to Solus Cloud to get one.</p>
          {:else}
            {#if selectedAction.kind === "commands"}
              {#each selectedAction.commands as line, index (line)}
                <div class="flex min-w-0 items-center gap-2 rounded-lg bg-(--solus-surface-hover) py-1.5 pr-1.5 pl-2.5">
                  <code class="min-w-0 flex-1 truncate font-mono text-chrome-dense text-(--solus-text-primary)">{line}</code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="shrink-0 text-(--solus-text-tertiary)"
                    onclick={() => copy(line, `guide-command-${index}`)}
                    aria-label={`Copy the command ${line}`}
                  >
                    {#if copiedField === `guide-command-${index}`}
                      <CheckIcon size={13} class="text-(--solus-status-complete)" />
                    {:else}
                      <CopyIcon size={13} />
                    {/if}
                  </Button>
                </div>
              {/each}
            {:else}
              {@const action = selectedAction}
              <div>
                <Button size="sm" onclick={() => void handOff(selected.guide.id, selected.guide.name, action)}>
                  <ExternalLinkIcon size={14} />
                  {action.label}
                </Button>
              </div>
            {/if}
            {#if selectedHandoff?.error}
              <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{selectedHandoff.error}</p>
            {:else if selectedHandoff?.note || selectedHandoff?.fallbackLink}
              <p class="flex flex-wrap items-center gap-x-2 text-chrome-dense text-(--solus-text-secondary)">
                {selectedHandoff.note ?? ""}
                {#if selectedHandoff.fallbackLink}
                  {@const fallbackLink = selectedHandoff.fallbackLink}
                  <button
                    type="button"
                    class="text-(--solus-text-primary) underline-offset-4 outline-none hover:underline focus-visible:underline"
                    onclick={() => void openOutsideApp({ link: fallbackLink, appLink: null }, opener)}
                  >
                    Not open? Open {selected.guide.name}
                  </button>
                {/if}
              </p>
            {/if}
            <ol class="flex list-decimal flex-col gap-1 pl-5 text-chrome-dense text-(--solus-text-secondary)">
              {#each selected.guide.steps as step (step)}
                <li>{step}</li>
              {/each}
            </ol>
          {/if}
          {#if selected.guide.docs}
            {@const docs = selected.guide.docs}
            <div>
              <button
                type="button"
                class="text-chrome-dense text-(--solus-text-secondary) underline-offset-4 outline-none hover:text-(--solus-text-primary) hover:underline focus-visible:underline"
                onclick={() => void openOutsideApp({ link: docs, appLink: null }, opener)}
              >
                {selected.guide.name} documentation
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2 px-4 py-3.5">
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

  <SettingsRow
    label="Pairing code"
    description="Type it on the app's sign-in page to approve the app. It works once, for 10 minutes. The app acts as you."
    bodyVisible={!!code || !!connections.appPairingCodeError}
  >
    {#snippet control()}
      <Button
        variant="outline"
        size="sm"
        disabled={connections.appPairingCodeCreating}
        onclick={() => void connections.createAppPairingCode(serverId, 'write')}
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
</SettingsSection>
