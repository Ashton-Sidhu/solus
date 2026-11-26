<script lang="ts">
  /** What Solus adds to this machine. The machine's own load is in the summary
   *  above the tabs; the process table needs host admin. */
  import { formatResourceBytes, telemetryCpuShares, telemetrySummaryText, telemetryUnavailableText } from "@solus/client-core/host-resource-watch";
  import { hostResourcesStore } from "../../contexts/hosts/host-resources.store.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Sparkline } from "../ui/sparkline";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => hostResourcesStore.retain(serverId));

  const telemetry = $derived(hostResourcesStore.viewFor(serverId).telemetry);
  const cpuShares = $derived(telemetry.state === "live" ? telemetryCpuShares(telemetry.history) : []);
</script>

<SettingsSection label="Solus on this machine" description="Solus and the agents it started.">
  {#if telemetry.state === "hidden"}
    <SettingsRow label="Process details" description="Only a host admin sees the processes on this host." />
  {:else if telemetry.state === "unavailable"}
    <SettingsRow label="Process details" description={telemetryUnavailableText(telemetry.reason)} />
  {:else if telemetry.state === "loading" || !telemetry.sample}
    <SettingsRow label="Process details" description="Reading…" />
  {:else}
    {@const sample = telemetry.sample}
    <SettingsRow label="Total" description={telemetrySummaryText(sample)}>
      {#snippet body()}
        <Sparkline values={cpuShares} class="mt-3 h-12 w-full" label="CPU use of Solus over the last five minutes" />
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
