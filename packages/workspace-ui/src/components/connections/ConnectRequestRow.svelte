<script lang="ts">
  /**
   * One service the agent asked for, as a row of the connect card: the
   * service's mark, its name, one line on why, and the action at the right —
   * drawn like a row of the agent conversation card. A sign-in that needs more
   * than one button (a running flow, a code, an OAuth client, a key) opens
   * under the row, indented to the name.
   *
   * An integration's form is the Settings row's own connect form, so a sign-in
   * started here shows the same state there. A server that needs an OAuth
   * client shows the row's client form first, so the owner never leaves the
   * conversation (docs/plans/mcp-integrations.md §13.2).
   */
  import { localApi } from "@solus/client-core/local-api";
  import { untrack } from "svelte";
  import Icon from "@iconify/svelte";
  import { Check as CheckIcon, ExternalLink, Plug } from "@lucide/svelte";
  import type { ConnectRequest } from "../../contexts/connections/connect-request.store.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import AtlassianConnectForm from "../atlassian/AtlassianConnectForm.svelte";
  import CustomServerConnectForm from "./CustomServerConnectForm.svelte";
  import GitHubConnectForm from "./GitHubConnectForm.svelte";
  import IntegrationConnectForm from "../settings/IntegrationConnectForm.svelte";
  import IntegrationOAuthClientForm from "../settings/IntegrationOAuthClientForm.svelte";
  import { integrationsStore } from "../settings/integrations.store.svelte";
  import { IntegrationLabels } from "../settings/lib/integration-labels";
  import { connectRequestCopy } from "./lib/connect-card-copy";
  import { connectsInOneLine } from "./lib/connect-card-layout";
  import { connectRequestStatus } from "./lib/connect-request-status";

  interface Props {
    request: ConnectRequest;
    /** "Set up with an agent": the card closes and a new chat opens with this prompt. */
    onhandoff: (prompt: string) => void;
  }

  let { request, onhandoff }: Props = $props();

  const serverId = $derived(request.serverId);
  const copy = $derived(connectRequestCopy(request));
  const status = $derived(connectRequestStatus(request));
  const connected = $derived(status === "connected");
  const integrationId = $derived(request.kind === "integration" ? request.integrationId : null);
  const hostState = $derived(integrationId ? integrationsStore.states.get(serverId) : undefined);
  const setupHandoff = $derived(integrationId ? integrationsStore.setupHandoff(serverId, integrationId) : null);
  const integrationNeedingClient = $derived(integrationId ? integrationsStore.integrationNeedingClient(serverId, integrationId) : null);
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
  const accountConnectionsUrl = $derived(request.kind === "account" ? request.accountConnectionsUrl : undefined);
  const hasBody = $derived(!connected && (!isOneLine || !!copy.note) && !accountConnectionsUrl);

  // The one-line row mounts no connect form, so it reads the host itself.
  $effect(() => {
    if (request.kind === "account") return;
    const hostId = serverId;
    return untrack(() => integrationsStore.watch(hostId));
  });
</script>

<div class="flex min-w-0 flex-col rounded-md px-2 py-1.5" data-testid="connect-request-row" data-state={status}>
  <div class="flex w-full min-w-0 items-center gap-2.5">
    <span
      aria-hidden="true"
      class="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_2%,var(--solus-tx-card-bg))] text-muted-foreground dark:border-[color-mix(in_oklch,white_5%,transparent)] dark:bg-[color-mix(in_oklch,white_3%,var(--solus-tx-card-bg))]"
    >
      {#if request.kind !== "account"}
        <Plug size={13} />
      {:else}
        <Icon icon={PROVIDER_LOGOS[request.provider]} width={13} height={13} />
      {/if}
      {#if connected}
        <span
          class="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-(--chart-3) text-white ring-2 ring-(--solus-tx-card-bg)"
        >
          <CheckIcon size={8} strokeWidth={3.5} />
        </span>
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs font-medium text-(--solus-text-primary)">{copy.name}</span>
      <span class="block truncate text-[0.6875rem] leading-relaxed text-muted-foreground">
        {connected ? "Connected" : copy.purpose}
      </span>
    </span>
    <span class="flex shrink-0 items-center gap-1.5">
      {#if !connected}
        {#if setupHandoff}
          <TranscriptCardAction kind="ghost" onclick={() => onhandoff(setupHandoff.prompt)}>Set up with an agent</TranscriptCardAction>
        {/if}
        {#if isOneLine && integrationId}
          <TranscriptCardAction
            kind="filled"
            disabled={hostState?.isDisconnected}
            onclick={() => void integrationsStore.connect(serverId, integrationId)}
          >
            Connect
          </TranscriptCardAction>
        {:else if accountConnectionsUrl}
          <TranscriptCardAction kind="filled" onclick={() => void localApi.openExternal(accountConnectionsUrl)}>
            Open account connections<ExternalLink size={14} aria-hidden="true" />
          </TranscriptCardAction>
        {/if}
      {/if}
    </span>
  </div>
  {#if hasBody}
    <!-- Indented to the name: the 24px mark and the 10px gap. -->
    <div class="flex min-w-0 flex-col gap-2 pt-2 pl-[2.125rem] text-transcript-meta">
      <!-- Connect waits for the client, so the row shows one step at a time. -->
      {#if request.kind === "custom-server"}
        <CustomServerConnectForm {request} {onhandoff} />
      {:else if integrationNeedingClient}
        <IntegrationOAuthClientForm {serverId} integration={integrationNeedingClient} compact />
      {:else if request.kind === "integration" && !isOneLine}
        <IntegrationConnectForm {serverId} integrationId={request.integrationId} integrationName={request.integrationName} compact />
      {:else if request.kind === "account" && request.provider === "atlassian"}
        <AtlassianConnectForm {serverId} />
      {:else if request.kind === "account" && request.provider === "github"}
        <GitHubConnectForm {serverId} />
      {:else if request.kind === "account" && request.provider === "google"}
        <p class="m-0 text-muted-foreground">Connect this account in Settings, then continue.</p>
      {/if}
      {#if copy.note}
        <p class="m-0 text-muted-foreground opacity-80">{copy.note}</p>
      {/if}
    </div>
  {/if}
</div>
