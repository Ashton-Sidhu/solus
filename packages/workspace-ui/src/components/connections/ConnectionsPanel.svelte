<script lang="ts">
  import { untrack } from "svelte";
  /** Hosts is three pages: the fleet, one host, and Add a machine.
   *  Everything about how one host is reached — its
   *  network, pairing, devices, and Solus Cloud link — is on that host's page. */
  import { connectionsStore, serversStore } from "../../contexts";
  import AddMachinePage from "../fleet/AddMachinePage.svelte";
  import FleetView from "../fleet/FleetView.svelte";
  import HostDetail from "./HostDetail.svelte";
  import { connectionsNav } from "./connections-nav.svelte";

  // Resolved rather than trusted: a host forgotten from its own page would
  // otherwise leave the page open on a host that no longer exists.
  const host = $derived(
    serversStore.servers.find((server) => server.id === connectionsNav.hostId) ??
      null,
  );

  $effect(() => {
    const targetServerId = host?.id;
    if (!targetServerId) return;
    untrack(() => { void connectionsStore.refreshServerMetadata(targetServerId); });
    const interval = setInterval(
      () => void connectionsStore.refreshServerMetadata(targetServerId),
      5000,
    );
    return () => clearInterval(interval);
  });
</script>

{#if connectionsNav.isAdding}
  <AddMachinePage />
{:else if host}
  <HostDetail {host} />
{:else}
  <FleetView />
{/if}
