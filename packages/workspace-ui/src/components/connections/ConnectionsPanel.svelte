<script lang="ts">
  import { untrack } from "svelte";
  /** Hosts is two pages: the list of hosts, and one host. Everything about how
   *  one host is reached — its network, pairing, devices, and Solus Cloud link —
   *  is on that host's page, so the list stays a list. */
  import { connectionsStore, serversStore } from "../../contexts";
  import HostDirectory from "../servers/HostDirectory.svelte";
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

{#if host}
  <HostDetail {host} />
{:else}
  <HostDirectory />
{/if}
