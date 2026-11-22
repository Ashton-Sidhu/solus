<script lang="ts">
  /** The setup card of a conversation that runs or failed: worktree setup,
   *  a Run on copy, or a session sync with its recovery actions. A refused
   *  cloud push takes its place with Fork and "Use the newer copy". */
  import type { Session } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import StatusCard from "./StatusCard.svelte";
  import { seatProviderOf, seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { SESSION_DIVERGED } from "@solus/contracts/session-repositories";
  import { sessionCloudStateText } from "@solus/client-core/session-cloud-state";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { sessionListStore } from "../../contexts/workspace/session-list.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import PushRefusedCard from "./PushRefusedCard.svelte";

  interface Props {
    sess: Session;
    tabId: string;
    onCancel: () => void;
  }

  let { sess, tabId, onCancel }: Props = $props();
  const session = getWorkspaceContext();
  const seatProvider = $derived(seatProviderOf(sess.run.provider));
  const cloudState = $derived(
    sessionListStore.cloudStateFor(sess.id, serverConnections.resolveId(runHost(sess.run)), sess.statusCard?.promptRefusalCode === SESSION_DIVERGED),
  );
  const refusal = $derived(cloudState?.kind === "push-refused" ? cloudState : null);

  /** A sync that needs a seat opens the same connect card a refused prompt does. */
  function connectSeat() {
    if (seatProvider) seatsStore.noteRefusal(runHost(sess.run), sess.id, seatProvider);
  }
</script>

<!-- A finished setup card belongs to the turn its send started, so the last
     turn draws it; this slot is for setup that runs or failed. -->
{#if refusal}
  <PushRefusedCard
    text={sessionCloudStateText(refusal, (serverId) => (serverId ? serversStore.hostFor(serverId)?.label : null) ?? "another machine")}
    onFork={() => void session.opening.forkTab(tabId)}
    onUseNewerCopy={() => {
      void session.runHosts.useNewerCopy(tabId);
      requestInputFocus({ tabId });
    }}
  />
{:else if sess.statusCard && sess.statusCard.status !== "done"}
  <StatusCard
    card={sess.statusCard}
    onRetry={() => session.controls.recoverWorktreeSetup(tabId, false)}
    onWorkLocally={() => session.controls.recoverWorktreeSetup(tabId, true)}
    {onCancel}
    onConnectSeat={connectSeat}
    connectSeatLabel={seatProvider === "codex" ? "Connect Codex" : "Connect Claude"}
  />
{/if}
