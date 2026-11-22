<script lang="ts">
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { sessionListStore } from "../../contexts/workspace/session-list.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import { isHostOffline, offlineLastRunHost, runHostRowNote } from "./lib/run-host-row";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const runServerId = $derived(sess ? serverConnections.resolveId(runHost(sess.run)) : null);
  const offlineServerId = $derived(
    sess && runServerId
      ? offlineLastRunHost({
          newestServerId: sessionListStore.newestHostFor(sess.id, runServerId),
          runServerId,
          isOffline: (serverId) => isHostOffline(serversStore.readinessFor(serverId)),
        })
      : null,
  );
  const offlineLabel = $derived(offlineServerId ? (serversStore.hostFor(offlineServerId)?.label ?? "The last host") : null);
  const cloudState = $derived(sess && runServerId ? sessionListStore.cloudStateFor(sess.id, runServerId) : null);
  const note = $derived(runHostRowNote(cloudState, offlineLabel, (serverId) => (serverId ? serversStore.hostFor(serverId)?.label : null) ?? "another machine"));
</script>

{#if note}
  <p role="status" class="min-w-0 truncate px-3.5 pt-2 text-chrome-dense text-(--solus-text-tertiary)">{note}</p>
{/if}
