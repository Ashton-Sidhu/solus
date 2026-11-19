<script lang="ts">
  /**
   * Run on for a started session (docs/plans/portable-sessions.md §10): the
   * next turn can run on another host. It sits under the composer card where a
   * draft's destination strip sits, and says when the host that has the
   * newest turn is offline, when another host runs a turn now, and when the
   * newest turn is not in the cloud yet (portable-sessions-cloud §8.1 E).
   * Typing is never blocked here.
   */
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext, hosts, serversStore } from "../../contexts";
  import { sessionListStore } from "../../contexts/workspace/session-list.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import RunOnPicker from "../servers/RunOnPicker.svelte";
  import { isRunOnHostLocked, shouldShowRunOnPicker } from "../servers/run-on";
  import { isHostOffline, offlineLastRunHost, runHostRowNote } from "./lib/run-host-row";

  interface Props {
    tabId: string;
    paneId?: string;
  }

  let { tabId, paneId }: Props = $props();

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
  const offersHosts = $derived(
    shouldShowRunOnPicker({
      connectedRemoteIds: serversStore.connectedRemotes.map((host) => host.id),
      localHostId: hosts.device?.id ?? null,
      selectedHostId: runHost(sess?.run),
    }),
  );
</script>

{#if sess && (offersHosts || note)}
  <div class="flex min-w-0 items-center gap-1.5 px-3.5 pt-2 text-workspace-chrome">
    <RunOnPicker
      run={sess.run}
      requesterId={tabId}
      locked={isRunOnHostLocked(sess) || cloudState?.kind === "running-elsewhere"}
      onRun={(next) => session.runHosts.change(tabId, next.location)}
      onDismiss={() => requestInputFocus({ tabId })}
      variant="header"
      {paneId}
    />
    {#if note}
      <span role="status" class="min-w-0 truncate text-chrome-dense text-(--solus-text-tertiary)">{note}</span>
    {/if}
  </div>
{/if}
