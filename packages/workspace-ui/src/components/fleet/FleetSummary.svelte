<script lang="ts">
  import { fleetSummary, type FleetMachine, type FleetTone } from "./lib/fleet-model";

  /** The four cells above the map (docs/plans/host-fleet.md D4). Each number has
   *  a line that names the hosts behind it, so the person knows where to look. */
  interface Props {
    machines: FleetMachine[];
  }

  let { machines }: Props = $props();

  const summary = $derived(fleetSummary(machines));
  const cells = $derived([
    { label: "Online", fact: summary.online },
    { label: "Sessions running", fact: summary.sessions },
    { label: "Busiest CPU", fact: summary.cpu },
    { label: "Needs attention", fact: summary.attention },
  ]);

  function toneClass(tone: FleetTone): string {
    return tone === "bad" ? "text-(--solus-status-error)" : tone === "warn" ? "text-(--warning)" : tone === "off" ? "text-muted-foreground" : "";
  }
</script>

<!-- Hairlines between the cells, reset for the column count: 2 across, then 4. -->
<div class="@container">
  <dl class="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none @[40rem]:grid-cols-4">
    {#each cells as cell (cell.label)}
      <div class="flex min-w-0 flex-col gap-1 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
        <dt class="truncate text-chrome-dense text-muted-foreground">{cell.label}</dt>
        <dd class="flex min-w-0 flex-col gap-1">
          <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums {toneClass(cell.fact.tone)}">{cell.fact.value}</p>
          <p class="truncate text-chrome-dense text-(--solus-text-secondary)" title={cell.fact.detail}>{cell.fact.detail}</p>
        </dd>
      </div>
    {/each}
  </dl>
</div>
