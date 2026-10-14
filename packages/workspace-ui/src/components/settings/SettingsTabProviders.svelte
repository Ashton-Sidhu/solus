<script lang="ts">
  /**
   * Settings → Providers: the agent harnesses a session on this host runs
   * through, Claude Code and Codex. The owner manages the host login; an
   * organization member manages their own seat instead
   * (docs/plans/provider-seats.md §3.6).
   */
  import { untrack } from "svelte";
  import { seatsStore } from "../../contexts";
  import { usesCloudAgentSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import ProviderPanel from "../servers/ProviderPanel.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const setup = $derived(hostSetupStore.sessionFor(serverId));
  const hasSeats = $derived(usesCloudAgentSeats(serverId) || seatsStore.hasSeats.get(serverId) === true);

  // Setup events belong to the host, so the page holds its subscription open
  // while it shows that host, and hands it back on the way out.
  $effect(() => {
    const targetServerId = serverId;
    return untrack(() => {
      const session = hostSetupStore.sessionFor(targetServerId);
      session.retain();
      void session.refreshReadiness();
      return () => session.release();
    });
  });
</script>

<SeatsSettings {serverId} />
{#if !hasSeats}
  <ProviderPanel {setup} />
{/if}
