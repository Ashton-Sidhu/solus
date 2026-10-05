<script lang="ts">
  /**
   * Before the first send (decision S7): a draft on a host that runs turns on
   * the author's own seat, for an agent the member has not connected there.
   * Without it, Send only learns about the seat from the host's refusal. The
   * connect flow is the one Settings and the refusal card use. An open
   * conversation mounts it too, so a member who joins a shared session learns
   * before they send; it steps aside while a turn runs (a steer needs no seat).
   */
  import type { AgentId } from "@solus/contracts/types";
  import { cloudAgentSeatsStore as cloudSeats, usesCloudAgentSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import { seatProviderOf, seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { seatNoticeShown } from "../../contexts/seats/seat-need";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import SeatConnectPanel from "./SeatConnectPanel.svelte";

  interface Props {
    /** The host the draft will run on. */
    serverId: string;
    /** The agent the draft will run. */
    provider: AgentId | null | undefined;
    /** A turn runs in the open conversation: the reader can steer it without a seat. */
    turnRunning?: boolean;
  }

  let { serverId, provider, turnRunning = false }: Props = $props();

  const seatProvider = $derived(seatProviderOf(provider));
  const cloud = $derived(usesCloudAgentSeats(serverId));
  const needed = $derived(!!seatProvider && (cloud ? cloudSeats.connected(seatProvider) === false : seatsStore.needsSeat(serverId, seatProvider)));
  const shown = $derived(
    !!seatProvider &&
      (cloud ? !turnRunning && needed : seatNoticeShown(seatsStore.hasSeats.get(serverId), seatsStore.seats.get(serverId), seatProvider, turnRunning)),
  );

  // Cloud connections come from the account; personal-host seats come from the host.
  $effect(() => {
    if (!seatProvider) return;
    if (cloud) return cloudSeats.watch();
    void seatsStore.refreshFor(serverId);
  });

  // Connected: the notice goes, and with it the control that held focus.
  // Typing is the next step, so a caret left on nothing goes to the composer.
  // Keyed on the seat, not on a turn starting: that is no action of the reader's.
  let wasNeeded = false;
  $effect(() => {
    const now = needed;
    if (wasNeeded && !now && (!document.activeElement || document.activeElement === document.body)) {
      requestInputFocus();
    }
    wasNeeded = now;
  });
</script>

{#if shown && seatProvider}
  <div
    class="mx-1 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1"
    data-testid="seat-needed-notice"
  >
    <div class="flex items-center gap-2 text-workspace-chrome text-(--solus-text-secondary)">
      <ProviderMark mark={seatProvider === "claude-code" ? "claude" : "codex"} transparent />
      <span class="min-w-0 text-pretty">
        Connect to start chatting.
      </span>
    </div>
    <SeatConnectPanel {serverId} provider={seatProvider} compact />
  </div>
{/if}
