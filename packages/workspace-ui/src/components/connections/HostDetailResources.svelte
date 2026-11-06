<script lang="ts">
  /** What this machine carries now, and what Solus adds to it. Machine load needs
   *  no monitor, so it shows on each host; the process table needs host admin. */
  import { formatResourceBytes, machineCpuText, machineMemoryText, machineMemoryUsedShare, telemetrySparkline, telemetrySummaryText, telemetryUnavailableText } from "@solus/client-core/host-resource-watch";
  import { hostResourcesStore } from "../../contexts/hosts/host-resources.store.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => hostResourcesStore.retain(serverId));

  const view = $derived(hostResourcesStore.viewFor(serverId));
  const resources = $derived(view.resources);
  const telemetry = $derived(view.telemetry);
  const sparkline = $derived(telemetry.state === "live" ? telemetrySparkline(telemetry.history, 240, 32) : null);
  const staleNote = $derived(view.stale ? (resources ? " · The host does not answer. This is the last read." : "") : "");
</script>

{#snippet meter(share: number)}
  <div class="h-1.5 w-32 overflow-hidden rounded-full bg-(--solus-surface-hover)" aria-hidden="true">
    <div class="h-full rounded-full bg-(--solus-accent)" style="width: {Math.round(Math.min(1, share) * 100)}%"></div>
  </div>
{/snippet}

<SettingsSection label="This machine">
  {#if resources}
    <SettingsRow label="CPU" description={machineCpuText(resources) + staleNote}>
      {#snippet control()}
        {@render meter(resources.cpuUtilization ?? 0)}
      {/snippet}
    </SettingsRow>
    <SettingsRow label="Memory" description={machineMemoryText(resources) + staleNote}>
      {#snippet control()}
        {@render meter(machineMemoryUsedShare(resources))}
      {/snippet}
    </SettingsRow>
  {:else}
    <SettingsRow label="CPU and memory" description={view.stale ? "This host does not answer." : "Reading…"} />
  {/if}
</SettingsSection>

{#if telemetry.state !== "hidden"}
  <SettingsSection label="Solus on this machine" description="Solus and the agents it started.">
    {#if telemetry.state === "unavailable"}
      <SettingsRow label="Process details" description={telemetryUnavailableText(telemetry.reason)} />
    {:else if telemetry.state === "loading" || !telemetry.sample}
      <SettingsRow label="Process details" description="Reading…" />
    {:else}
      {@const sample = telemetry.sample}
      <SettingsRow label="Total" description={telemetrySummaryText(sample)}>
        {#snippet control()}
          {#if sparkline}
            <svg viewBox="0 0 240 32" class="h-8 w-40 text-(--solus-accent)" role="img" aria-label="CPU use over the last five minutes">
              <polyline points={sparkline} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
            </svg>
          {/if}
        {/snippet}
      </SettingsRow>
      <SettingsRow label="Busiest processes">
        {#snippet body()}
          <table class="mt-2 w-full table-fixed text-chrome-dense">
            <thead class="text-left text-(--solus-text-tertiary)">
              <tr>
                <th scope="col" class="py-1 font-normal">Process</th>
                <th scope="col" class="w-16 py-1 text-right font-normal">CPU</th>
                <th scope="col" class="w-20 py-1 text-right font-normal">Memory</th>
              </tr>
            </thead>
            <tbody>
              {#each sample.processes as process (process.pid)}
                <tr title={process.command}>
                  <td class="truncate py-1 text-(--solus-text-secondary)">{process.name}</td>
                  <td class="py-1 text-right tabular-nums text-(--solus-text-secondary)">{Math.round(process.cpuPercent)}%</td>
                  <td class="py-1 text-right tabular-nums text-(--solus-text-secondary)">{formatResourceBytes(process.residentBytes)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </SettingsRow>
    {/if}
  </SettingsSection>
{/if}
