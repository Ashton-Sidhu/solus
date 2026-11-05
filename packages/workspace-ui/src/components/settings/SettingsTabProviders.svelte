<script lang="ts">
  /**
   * Settings → Providers: the agent harnesses a session on this host runs
   * through, Claude Code and Codex. The owner manages the host login; an
   * organization member manages their own seat instead
   * (docs/plans/provider-seats.md §3.6).
   */
  import type { Snippet } from "svelte";
  import ProjectProviderSettings from "./ProjectProviderSettings.svelte";
  import ProviderInstancesSettings from "./ProviderInstancesSettings.svelte";
  import { untrack } from "svelte";
  import { seatsStore } from "../../contexts";
  import { usesCloudAgentSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import ProviderPanel from "../servers/ProviderPanel.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";

  interface Props {
    serverId?: string;
    projectCwd?: string | null;
    scopeControl?: Snippet;
  }

  let { serverId, projectCwd, scopeControl }: Props = $props();

  const setup = $derived(serverId ? hostSetupStore.sessionFor(serverId) : null);
  const hasSeats = $derived(!!serverId && (usesCloudAgentSeats(serverId) || seatsStore.hasSeats.get(serverId) === true));

  // Setup events belong to the host, so the page holds its subscription open
  // while it shows that host, and hands it back on the way out.
  $effect(() => {
    const targetServerId = serverId;
    if (!targetServerId) return;
    return untrack(() => {
      const session = hostSetupStore.sessionFor(targetServerId);
      session.retain();
      void session.refreshReadiness();
      return () => session.release();
    });
  });
</script>

{#if projectCwd && serverId}
  <div class="flex flex-col gap-5">
    {@render scopeControl?.()}
    <ProjectProviderSettings {serverId} cwd={projectCwd} />
  </div>
{:else}
  {#if serverId && setup}
    <SeatsSettings {serverId} />
    {#if !hasSeats}<ProviderPanel {setup} />{/if}
  {:else}
    <p class="text-workspace-chrome text-muted-foreground">Connect a host to manage providers, sign-in, and models.</p>
  {/if}
  {#if serverId}
    <div class="flex flex-col gap-5">
      {@render scopeControl?.()}
      <ProviderInstancesSettings {serverId} />
    </div>
  {/if}
  <p class="text-workspace-chrome text-muted-foreground">These model preferences are yours. They follow your account when settings sync is on.</p>
{/if}
