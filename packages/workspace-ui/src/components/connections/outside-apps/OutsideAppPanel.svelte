<script lang="ts">
  /** What an open row of "Use Solus from your other apps" shows. A connected
   *  app: a facts card for each of its sign-ins, "Connect again", and
   *  Disconnect. Any other app: the gate until the host has an address the app
   *  reaches, then how to connect it (`OutsideAppConnect`). The host has no
   *  call that changes an app's access, so a new level is a new sign-in. */
  import { untrack } from "svelte";
  import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
  import { connectionsStore, uplinkStore } from "../../../contexts";
  import { Button } from "../../ui/button";
  import { outsideAppAddressKind } from "../lib/outside-apps";
  import { resolveOutsideAppGate } from "../lib/outside-apps-gate";
  import { grantFacts, hasNewGrant, type AppGrant } from "../lib/outside-apps-directory";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppConnect from "./OutsideAppConnect.svelte";
  import OutsideAppsGate from "./OutsideAppsGate.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    /** Null for Another MCP app. */
    guide: OutsideAppGuide | null;
    /** The app's sign-ins that still have access, newest first. */
    grants: readonly AppGrant[];
    onHostComputer: boolean;
  }

  let { serverId, hostName, guide, grants, onHostComputer }: Props = $props();

  let isConnectingAgain = $state(false);
  let revokingId = $state<string | null>(null);
  const grantIdsAtOpen = new Set(untrack(() => grants.map((grant) => grant.deviceId)));

  const appName = $derived(guide?.name ?? "the app");
  const showsFacts = $derived(grants.length > 0 && !isConnectingAgain);
  const endpoint = $derived(connectionsStore.appEndpointFor(serverId));
  const gate = $derived(resolveOutsideAppGate({
    addressKind: outsideAppAddressKind(guide, onHostComputer),
    endpoint,
    endpointError: connectionsStore.appEndpointErrorFor(serverId),
    uplink: uplinkStore.statusFor(serverId),
    uplinkError: uplinkStore.statusErrorFor(serverId),
    addressTests: connectionsStore.appAddressTestsFor(serverId),
    acceptedUrl: outsideApps.acceptedUrl,
    turningOn: outsideApps.turningOnServerId === serverId,
  }));
  const testSource = $derived(!showsFacts && gate.kind === "checking" ? gate.testSource : null);
  // The gate reads the Solus Cloud link once it knows the host has no address the app reaches.
  const needsUplink = $derived(!showsFacts && !!endpoint && uplinkStore.statusFor(serverId) === undefined && uplinkStore.statusErrorFor(serverId) === null);

  // The gate tests the chosen address before the app's code shows.
  $effect(() => {
    const source = testSource;
    if (source) untrack(() => void connectionsStore.testAppAddress(serverId, source));
  });

  $effect(() => {
    if (needsUplink) untrack(() => void outsideApps.readUplink(serverId));
  });

  async function disconnect(grant: AppGrant) {
    revokingId = grant.deviceId;
    await connectionsStore.revokeDevice(serverId, grant.deviceId);
    revokingId = null;
  }
</script>

<div class="flex flex-col gap-3.5">
  {#if showsFacts}
    {#each grants as grant (grant.deviceId)}
      {@const facts = grantFacts(grant)}
      <div class="flex flex-col gap-2">
        <dl class="flex flex-col rounded-[0.625rem] bg-(--solus-code-bg) text-[0.8125rem] leading-4 ring-1 ring-border">
          <div class="flex justify-between gap-3 border-b border-border px-3.5 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Connected</dt>
            <dd class="truncate text-(--solus-text-primary)">{facts.connected}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-border px-3.5 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Last used</dt>
            <dd class="truncate text-(--solus-text-primary)">{facts.lastUsed}</dd>
          </div>
          <div class="flex justify-between gap-3 px-3.5 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Can</dt>
            <dd class="truncate text-(--solus-text-primary)">{facts.access}</dd>
          </div>
        </dl>
        {#if grants.length > 1}
          <div class="flex items-center justify-between gap-3">
            <span class="min-w-0 truncate text-chrome-dense text-(--solus-text-tertiary)">{grant.deviceLabel}</span>
            <Button variant="ghost" size="sm" class="text-(--solus-status-error) hover:text-(--solus-status-error)" disabled={revokingId !== null} onclick={() => void disconnect(grant)}>
              {revokingId === grant.deviceId ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        {/if}
      </div>
    {/each}
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onclick={() => (isConnectingAgain = true)}>Connect again</Button>
      {#if grants.length === 1}
        {@const [only] = grants}
        <Button variant="ghost" size="sm" class="text-(--solus-status-error) hover:text-(--solus-status-error)" disabled={revokingId !== null} onclick={() => void disconnect(only)}>
          {revokingId === only.deviceId ? "Disconnecting…" : "Disconnect"}
        </Button>
      {/if}
    </div>
    <p class="text-chrome-dense text-pretty text-(--solus-text-tertiary)">
      Solus cannot change the access of a connected app. To change it, connect {appName} again at the new level, then disconnect the old connection.
    </p>
  {:else}
    {#if gate.kind === "open"}
      <OutsideAppConnect
        {serverId}
        {hostName}
        {guide}
        mcpUrl={gate.mcpUrl}
        localUrl={endpoint && gate.mcpUrl !== endpoint.localUrl ? endpoint.localUrl : null}
        warning={gate.warning}
        hasSignedIn={hasNewGrant(grantIdsAtOpen, grants)}
      />
    {:else}
      <OutsideAppsGate {serverId} {hostName} appName={guide?.name ?? "This app"} {gate} />
    {/if}
    {#if isConnectingAgain}
      <div>
        <Button variant="ghost" size="sm" class="-ml-2" onclick={() => (isConnectingAgain = false)}>Back to the connection</Button>
      </div>
    {/if}
  {/if}
</div>
