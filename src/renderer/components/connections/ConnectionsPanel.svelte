<script lang="ts">
  /** Connections is two pages: the list of everything, and one host. */
  import { serverConnections } from "@client-core/server-connections";
  import { connectionsStore, serversStore } from "../../contexts";
  import ConnectionsList from "./ConnectionsList.svelte";
  import HostDetail from "./HostDetail.svelte";
  import { connectionsNav } from "./connections-nav.svelte";

  // Resolved rather than trusted: a host forgotten from its own page would
  // otherwise leave the page open on a host that no longer exists.
  const host = $derived(
    serversStore.servers.find((server) => server.id === connectionsNav.hostId) ??
      null,
  );
  const serverId = $derived(host?.id ?? serverConnections.defaultServerId());

  $effect(() => {
    const targetServerId = serverId;
    if (!targetServerId) return;
    void connectionsStore.refreshServerMetadata(targetServerId);
    const interval = setInterval(
      () => void connectionsStore.refreshServerMetadata(targetServerId),
      5000,
    );
    return () => clearInterval(interval);
  });
</script>

{#if host}
  <HostDetail {host} />
{:else if serverId}
  <ConnectionsList {serverId} />
{/if}
