<script lang="ts">
  /**
   * An agent asked for an external account mid-turn. That is an interrupt like
   * any other — something stopped and only the user can restart it — so it takes
   * the attention shell and stands at the tail of the transcript beside the
   * permission and question cards, not in a chrome banner of its own. Once the
   * account is connected, it collapses to a quiet line that offers Continue.
   *
   * One card for every provider. Each is a browser sign-in whose answer
   * arrives on a host event; the body is the part that differs.
   *
   * An integration (docs/plans/mcp-integrations.md §7) uses the same shell; its
   * body is the Settings row's own connect form, so a sign-in started here
   * shows the same state there. A server that needs an OAuth client shows the
   * row's client form first, so the owner never leaves the conversation (§13.2).
   */
  import { localApi } from "@solus/client-core/local-api";
  import { untrack } from "svelte";
  import Icon from "@iconify/svelte";
  import { Plug } from "@lucide/svelte";
  import {
    atlassianStore,
    connectionsStore,
    connectRequestStore,
    getWorkspaceContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { ensureIconCollections } from "../diagram/iconify";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import AtlassianConnectForm from "../atlassian/AtlassianConnectForm.svelte";
  import GitHubConnectForm from "./GitHubConnectForm.svelte";
  import IntegrationConnectForm from "../settings/IntegrationConnectForm.svelte";
  import IntegrationOAuthClientForm from "../settings/IntegrationOAuthClientForm.svelte";
  import { integrationsStore } from "../settings/integrations.store.svelte";
  import { IntegrationLabels } from "../settings/lib/integration-labels";
  import { connectCardCopy, integrationConnectCardCopy } from "./lib/connect-card-copy";
  import { connectsInOneLine } from "./lib/connect-card-layout";
  import { openChatDraft } from "../../contexts/workspace/new-chat";
  import { runHost } from "../../contexts/workspace/run-location";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  ensureIconCollections();

  const session = getWorkspaceContext();
  const request = $derived(connectRequestStore.request);
  const serverId = $derived(runHost(session.sessionFor(tabId)?.run));
  const copy = $derived.by(() => {
    if (!request) return null;
    if (request.kind === "integration") return integrationConnectCardCopy(request.integrationName);
    return connectCardCopy(request.provider, request.reason);
  });
  const accountConnectionsUrl = $derived(request?.kind === "account" ? request.accountConnectionsUrl : undefined);
  const setupHandoff = $derived(
    request?.kind === "integration" && serverId ? integrationsStore.setupHandoff(serverId, request.integrationId) : null,
  );
  const integrationNeedingClient = $derived(
    request?.kind === "integration" && serverId ? integrationsStore.integrationNeedingClient(serverId, request.integrationId) : null,
  );
  const integrationId = $derived(request?.kind === "integration" ? request.integrationId : null);
  const hostState = $derived(serverId ? integrationsStore.states.get(serverId) : undefined);
  const isOneLine = $derived.by(() => {
    if (!integrationId) return false;
    const integration = hostState?.integrations?.find((item) => item.id === integrationId);
    return connectsInOneLine({
      connectionsStatus: hostState?.connectionsStatus,
      hasConnection: hostState?.connections.has(integrationId) ?? false,
      flow: hostState?.connectFlows.get(integrationId) ?? null,
      needsClient: !!integration && new IntegrationLabels(integration).clientText?.state === "missing",
    });
  });

  // The one-line card mounts no connect form, so it reads the host itself.
  $effect(() => {
    const hostId = request?.kind === "integration" ? serverId : undefined;
    if (!hostId) return;
    return untrack(() => integrationsStore.watch(hostId));
  });

  const connected = $derived.by(() => {
    if (!request || !serverId || accountConnectionsUrl) return false;
    if (request.kind === "integration")
      return integrationsStore.connection(serverId, request.integrationId)?.status === "connected";
    if (request.provider === "atlassian") return atlassianStore.connected(serverId);
    if (request.provider === "github")
      return (
        connectionsStore.providerLoaded &&
        !!connectionsStore.providerStatus?.connected
      );
    return false;
  });

  let cardEl = $state<HTMLDivElement | null>(null);

  function dismiss() {
    // A sign-in this card started ends with it, here and on the host.
    if (request?.kind === "integration" && serverId && !connected)
      void integrationsStore.cancel(serverId, request.integrationId);
    connectRequestStore.dismiss();
    requestInputFocus();
  }

  function connectIntegration() {
    if (serverId && integrationId) void integrationsStore.connect(serverId, integrationId);
  }

  /** "Set up with an agent" (§13.4): a new chat on this host whose prompt finds what to create. */
  function handOff() {
    const prompt = setupHandoff?.prompt;
    if (!prompt || !serverId) return;
    dismiss();
    openChatDraft(session, "click", { serverId, prompt });
  }

  // The turn is still waiting on the agent's side, so the way back in is a
  // prompt, not a silent resume.
  function continueRun() {
    if (copy) session.dispatch.sendMessage(`${copy.providerLabel} connected — continue`, undefined, tabId);
    connectRequestStore.dismiss();
    requestInputFocus();
  }

  // Escape belongs to whatever owns focus. While the caret is in this card it
  // is the card's; the conversation's own Escape bindings keep it otherwise.
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if request && copy}
  <div bind:this={cardEl}>
    <AttentionCard
      title={connected ? `${copy.providerLabel} connected` : copy.title}
      type={connected ? "continue the turn" : copy.reason}
      resolved={connected}
      testId="connection-connect-card"
      actionsOnCardLine={request.kind === "integration"}
      children={isOneLine ? undefined : cardBody}
    >
      {#snippet icon()}
        <span class="inline-flex size-5 items-center justify-center rounded-md bg-card shadow-[shadow:var(--solus-tx-hairline)]">
          {#if request.kind === "integration"}
            <Plug size={13} aria-hidden="true" />
          {:else}
            <Icon icon={PROVIDER_LOGOS[request.provider]} aria-hidden="true" />
          {/if}
        </span>
      {/snippet}

      {#snippet actions()}
        {#if connected}
          <TranscriptCardAction kind="ghost" onclick={dismiss}>Done</TranscriptCardAction>
          <TranscriptCardAction onclick={continueRun}>Continue</TranscriptCardAction>
        {:else}
          <div class="flex flex-wrap items-end justify-end gap-2">
            <TranscriptCardAction kind="ghost" onclick={dismiss}>Not now</TranscriptCardAction>
            {#if setupHandoff}
              <TranscriptCardAction kind="ghost" onclick={handOff}>Set up with an agent</TranscriptCardAction>
            {/if}
            {#if isOneLine}
              <TranscriptCardAction kind="filled" disabled={hostState?.isDisconnected} onclick={connectIntegration}>Connect</TranscriptCardAction>
            {/if}
            {#if serverId && request.kind === "account"}
              {#if accountConnectionsUrl}
                <TranscriptCardAction kind="filled" onclick={() => void localApi.openExternal(accountConnectionsUrl)}>
                  Open account connections
                </TranscriptCardAction>
                <TranscriptCardAction onclick={continueRun}>Continue</TranscriptCardAction>
              {:else if request.provider === "atlassian"}
                <AtlassianConnectForm {serverId} />
              {:else if request.provider === "github"}
                <GitHubConnectForm {serverId} />
              {/if}
            {/if}
          </div>
        {/if}
      {/snippet}
    </AttentionCard>
  </div>
{/if}

{#snippet cardBody()}
  {#if request && copy}
    {#if copy.purpose}
      <p class="m-0 text-(--muted-foreground)">{copy.purpose}</p>
    {/if}

    <!-- Connect waits for the client, so the card shows one step at a time. -->
    {#if integrationNeedingClient && serverId}
      <IntegrationOAuthClientForm {serverId} integration={integrationNeedingClient} compact />
    {:else if request.kind === "integration" && serverId}
      <IntegrationConnectForm {serverId} integrationId={request.integrationId} integrationName={request.integrationName} compact />
    {/if}
    {#if accountConnectionsUrl}
      <p class="m-0 text-xs text-(--muted-foreground)">Connect your account, then return here and continue.</p>
    {:else if serverId && request.kind === "account" && request.provider === "google"}
      <p class="m-0 text-xs text-(--muted-foreground)">Connect this account in Settings, then continue.</p>
    {/if}
    {#if copy.note}
      <p class="m-0 text-xs text-(--muted-foreground) opacity-80">{copy.note}</p>
    {/if}
  {/if}
{/snippet}
