<script lang="ts">
  import HostStateIcon from "./HostStateIcon.svelte";
  import { statusLine, type FleetMachine } from "./lib/fleet-model";

  /** The status of the fleet on one line (docs/plans/host-fleet.md D13): how many
   *  hosts answer, then each other state as an icon with its count. The words
   *  are in each icon's tooltip. The map shows it above this device; the narrow
   *  tree shows it under this device. */
  let { machines }: { machines: FleetMachine[] } = $props();
  const line = $derived(statusLine(machines));
</script>

<p class="flex flex-wrap items-center gap-x-3 gap-y-1">
  <span class="text-[0.8125rem] font-medium whitespace-nowrap text-foreground tabular-nums">{line.online} of {line.total} online</span>
  {#each line.items as item (item.key)}
    <HostStateIcon state={item.state} label={item.label} count={item.count} size={12} />
  {/each}
</p>
