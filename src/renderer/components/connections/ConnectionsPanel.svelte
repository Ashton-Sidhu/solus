<script lang="ts">
  /** Connections is two pages: the list of everything, and one host. */
  import { onMount } from "svelte";
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

  onMount(() => {
    void connectionsStore.refreshServerMetadata();
    const interval = setInterval(
      () => void connectionsStore.refreshServerMetadata(),
      5000,
    );
    return () => clearInterval(interval);
  });
</script>

{#if host}
  <HostDetail {host} />
{:else}
  <ConnectionsList />
{/if}
