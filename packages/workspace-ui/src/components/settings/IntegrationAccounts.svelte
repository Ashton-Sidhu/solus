<script lang="ts">
  import { untrack } from "svelte";
  import { ExternalLink } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { getWorkspaceContext, serversStore, sharesStore, accountStore, connectionsStore } from "../../contexts";
  import { atlassianStore } from "../../contexts/atlassian/atlassian.store.svelte";
  import { googleStore } from "../../contexts/google/google.store.svelte";
  import AtlassianIntegrationRow from "../atlassian/AtlassianIntegrationRow.svelte";
  import GitHubIntegrationRow from "../connections/GitHubIntegrationRow.svelte";
  import GoogleIntegrationRow from "../google/GoogleIntegrationRow.svelte";
  import { accountVaultStore } from "../seats/account-vault.store.svelte";
  import { accountConnectionAction, accountConnectionDescription, cloudConnectionsPointerUrl, type AccountConnectionStatus } from "../seats/lib/cloud-connections";
  import { Button } from "../ui/button";
  import { ensureIconCollections } from "../../lib/iconify";
  import IntegrationRow from "./IntegrationRow.svelte";
  import LinearIntegrationRow from "./LinearIntegrationRow.svelte";
  import { keyConnectionFor } from "./key-connections.store";
  import { PROVIDER_LOGOS } from "./lib/provider-logos";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  type IntegrationId = "github" | "google" | "atlassian" | "linear";
  /** Where each integration sits on the page: still checking, hidden because
   *  this build cannot connect it, or in one of the two lists. */
  type Placement = "checking" | "unavailable" | "connected" | "available";
  type AccountIntegration = { name: string; logo: string; purpose: string; status: AccountConnectionStatus | null };

  ensureIconCollections();

  const session = getWorkspaceContext();
  const linearConnection = $derived(keyConnectionFor(serverId, { kind: "provider", provider: "linear" }));
  let linear = $state(untrack(() => linearConnection.current));

  // A signed-in person keeps their GitHub, Google, and Atlassian connections in
  // their Solus account, not on the host; each row shows the account's status
  // and points there. GitHub is on the Source Control page too.
  $effect(() => {
    void accountStore.state;
    const targetServerId = serverId;
    untrack(() => {
      void sharesStore.identityFor(targetServerId, true).catch(() => {});
      void accountVaultStore.load();
    });
  });
  $effect(() => accountVaultStore.watch());
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );

  // The page reads every status, so a row can move between the lists without
  // asking again.
  $effect(() => {
    if (cloudConnectionsUrl) return;
    const targetServerId = serverId;
    untrack(() => {
      void connectionsStore.refreshProviderStatus(targetServerId, session.ctx);
      void googleStore.ensureStatus(targetServerId);
      void atlassianStore.ensureStatus(targetServerId);
    });
  });
  $effect(() => {
    const store = linearConnection;
    linear = store.current;
    return store.subscribe(() => { linear = store.current; });
  });
  // A Linear key belongs to the account when one is signed in, so the
  // connection is read again whenever the account changes.
  const accountIdentity = $derived.by(() => {
    const account = accountStore.state;
    return account.kind === "signed-in" ? `${account.consoleUrl}:${account.identity.sub}` : account.kind;
  });
  $effect(() => {
    const store = linearConnection;
    void accountIdentity;
    untrack(() => { store.reset(); void store.load(); });
  });

  const accountIntegrations = $derived<Partial<Record<IntegrationId, AccountIntegration>>>({
    github: { name: "GitHub", logo: PROVIDER_LOGOS.github, purpose: "Read repositories, issues, Projects, and pull requests.", status: accountVaultStore.providerStatus("github") },
    google: { name: "Google Drive", logo: PROVIDER_LOGOS.google, purpose: "Publish and update Google Docs from works and plans.", status: accountVaultStore.providerStatus("google") },
    atlassian: { name: "Atlassian", logo: PROVIDER_LOGOS.atlassian, purpose: "Read and write Confluence pages and Jira issues.", status: accountVaultStore.providerStatus("atlassian") },
  });

  function accountPlacement(status: AccountConnectionStatus | null): Placement {
    if (!status || status.kind === "loading") return "checking";
    return status.kind === "connected" ? "connected" : "available";
  }

  const statusPlacements = $derived<[IntegrationId, Placement][]>([
    ["github", cloudConnectionsUrl
      ? accountPlacement(accountIntegrations.github?.status ?? null)
      : !connectionsStore.providerLoaded ? "checking" : connectionsStore.providerStatus?.connected ? "connected" : "available"],
    ["google", cloudConnectionsUrl
      ? accountPlacement(accountIntegrations.google?.status ?? null)
      : !googleStore.statusLoaded(serverId) ? "checking"
        : googleStore.connected(serverId) ? "connected"
        : googleStore.configured(serverId) ? "available" : "unavailable"],
    ["atlassian", cloudConnectionsUrl
      ? accountPlacement(accountIntegrations.atlassian?.status ?? null)
      : !atlassianStore.statusLoaded(serverId) ? "checking"
        : atlassianStore.connected(serverId) ? "connected"
        : atlassianStore.oauthAvailable(serverId) || atlassianStore.apiTokenAvailable(serverId) ? "available" : "unavailable"],
    ["linear", linear.connected ? "connected"
      : linear.location === "none" ? "unavailable"
      : linear.location === null && !linear.error ? "checking" : "available"],
  ]);
  // A status read again keeps its row where it was, so a refresh does not
  // blink the row out of its list.
  const answeredPlacements = new Map<IntegrationId, Placement>();
  const placements = $derived(statusPlacements.map(([id, placement]): [IntegrationId, Placement] => {
    if (placement !== "checking") answeredPlacements.set(id, placement);
    return [id, placement === "checking" ? (answeredPlacements.get(id) ?? "checking") : placement];
  }));
  const isChecking = $derived(placements.some(([, placement]) => placement === "checking"));
  const connected = $derived(placements.filter(([, placement]) => placement === "connected").map(([id]) => id));
  const available = $derived(placements.filter(([, placement]) => placement === "available").map(([id]) => id));
</script>

{#snippet row(id: IntegrationId)}
  {@const account = cloudConnectionsUrl ? accountIntegrations[id] : undefined}
  {#if account && cloudConnectionsUrl}
    {@const url = cloudConnectionsUrl}
    {@const actionLabel = accountConnectionAction(account.status)}
    <IntegrationRow name={account.name} logo={account.logo} description={accountConnectionDescription(account.status, account.purpose)}
      isConnected={account.status?.kind === "connected"} testId="connections-row-{id}-account">
      {#snippet action()}
        <Button variant="outline" size="sm"
          class="pointer-coarse:min-h-11" aria-label="{actionLabel} {account.name} on your Solus account"
          onclick={() => void localApi.openExternal(url)}>{actionLabel}<ExternalLink size={14} /></Button>
      {/snippet}
    </IntegrationRow>
  {:else if id === "github"}
    <GitHubIntegrationRow {serverId} />
  {:else if id === "google"}
    <GoogleIntegrationRow {serverId} />
  {:else if id === "atlassian"}
    <AtlassianIntegrationRow {serverId} />
  {:else}
    <LinearIntegrationRow {serverId} connection={linearConnection} {linear} />
  {/if}
{/snippet}

{#snippet list(label: string, ids: IntegrationId[])}
  <!-- Drawn as the MCP catalog: a small muted label and its count, then plain rows in two columns. -->
  <section class="flex flex-col gap-1" aria-label={label}>
    <div class="flex min-h-7 items-center gap-2">
      <h2 class="text-chrome-dense font-medium text-muted-foreground">{label}</h2>
      <span class="text-chrome-dense tabular-nums text-muted-foreground">{ids.length}</span>
    </div>
    <ul class="grid grid-cols-1 gap-x-14 @min-[56rem]/integrations:grid-cols-2">
      {#each ids as id (id)}{@render row(id)}{/each}
    </ul>
  </section>
{/snippet}

<!-- The Integrations page: the accounts Solus acts on your behalf with. -->
<div class="@container/integrations flex flex-col gap-6">
  <p class="max-w-xl text-pretty text-[13px] leading-[1.45] text-(--solus-text-secondary)">
    {cloudConnectionsUrl
      ? "These live in your Solus account, so every host you work on can use them."
      : "These connect on this host. Sign in to Solus to keep them in your account for every host."}
  </p>
  {#if isChecking}
    <!-- The shape of the rows, so the lists do not jump as each status arrives. -->
    <ul class="grid grid-cols-1 gap-x-14 pt-8 @min-[56rem]/integrations:grid-cols-2" aria-busy="true" aria-label="Checking connections">
      {#each { length: 4 } as _, index (index)}
        <li class="flex items-center gap-3.5 py-3" aria-hidden="true">
          <span class="size-8 shrink-0 rounded-lg bg-muted"></span>
          <div class="flex flex-1 flex-col gap-1.5">
            <span class="h-3.5 w-2/5 rounded bg-muted"></span>
            <span class="h-3 w-3/4 rounded bg-muted"></span>
          </div>
          <span class="h-7 w-20 shrink-0 rounded-lg bg-muted"></span>
        </li>
      {/each}
    </ul>
  {:else}
    {#if connected.length > 0}{@render list("Connected", connected)}{/if}
    {#if available.length > 0}{@render list("Available", available)}{/if}
    {#if connected.length === 0 && available.length === 0}
      <p class="text-workspace-chrome text-muted-foreground">This build of Solus has no integrations to connect.</p>
    {/if}
  {/if}
</div>
