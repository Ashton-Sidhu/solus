<script lang="ts">
  /** The setup card of a conversation that runs or failed: worktree setup,
   *  a Run on copy, or a session sync with its recovery actions. */
  import type { Session } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import StatusCard from "./StatusCard.svelte";
  import { seatProviderOf, seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";

  interface Props {
    sess: Session;
    tabId: string;
    onCancel: () => void;
  }

  let { sess, tabId, onCancel }: Props = $props();
  const session = getWorkspaceContext();
  const seatProvider = $derived(seatProviderOf(sess.run.provider));

  /** A sync that needs a seat opens the same connect card a refused prompt does. */
  function connectSeat() {
    if (seatProvider) seatsStore.noteRefusal(runHost(sess.run), sess.id, seatProvider);
  }

  /** A sync that failed on this host opens the Run on list of the composer. */
  function chooseHost() {
    window.dispatchEvent(new CustomEvent("solus:toggle-run-picker", { detail: {} }));
  }
</script>

<!-- A finished setup card belongs to the turn its send started, so the last
     turn draws it; this slot is for setup that runs or failed. -->
{#if sess.statusCard && sess.statusCard.status !== "done"}
  <StatusCard
    card={sess.statusCard}
    onRetry={() => session.controls.recoverWorktreeSetup(tabId, false)}
    onWorkLocally={() => session.controls.recoverWorktreeSetup(tabId, true)}
    {onCancel}
    onConnectSeat={connectSeat}
    connectSeatLabel={seatProvider === "codex" ? "Connect Codex" : "Connect Claude"}
    onChooseHost={chooseHost}
  />
{/if}
