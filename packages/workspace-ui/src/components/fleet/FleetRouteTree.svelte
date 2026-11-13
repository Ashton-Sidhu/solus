<script lang="ts">
  import { ChevronRight, Laptop } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { isZoneFull, machineMatches, machinesByZone, rollup, tileFill, toneOf, ZONES, type FleetMachine, type FleetZoneId, type TileColorMode } from "./lib/fleet-model";

  /** The map in a narrow pane (D4): the same routes as a tree, with this device
   *  at the top. A full zone is one row of small tiles that opens the zone. */
  interface Props {
    machines: FleetMachine[];
    colorMode: TileColorMode;
    query: string;
    selectedId: string | null;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string) => void;
    onOpenZone: (zone: FleetZoneId) => void;
  }

  let { machines, colorMode, query, selectedId, onPoint, onSelect, onOpenZone }: Props = $props();

  const byZone = $derived(machinesByZone(machines));
  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
</script>

<div class="flex flex-col gap-1 p-3">
  <div class="flex items-center gap-2.5 rounded-xl border border-(--solus-status-running)/30 bg-background py-2 pr-3 pl-2">
    <FleetLoadRing cpu={device?.cpu ?? null} tone="ok"><Laptop size={13} /></FleetLoadRing>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-[0.8125rem] font-medium">{device?.label ?? "This browser"}</span>
      <span class="text-chrome-dense text-(--solus-status-running)">This device</span>
    </span>
    {#if device?.sessions}<HostStateIcon state="running" count={device.sessions} />{/if}
  </div>
  <ul>
    {#each ZONES.filter((zone) => byZone[zone.id].length) as zone (zone.id)}
      {@const rows = byZone[zone.id]}
      <li class="relative flex flex-col gap-1.5 pt-3 pl-5 before:absolute before:top-0 before:bottom-0 before:left-[7px] before:w-px before:bg-(--success)/40 last:before:bottom-auto last:before:h-5">
        <span aria-hidden="true" class="absolute top-5 left-[7px] h-px w-3 bg-(--success)/40"></span>
        <p class="truncate text-chrome-dense font-medium text-(--solus-text-secondary)">{zone.label}</p>
        {#if isZoneFull(zone, rows.length)}
          {@const summary = rollup(rows)}
          <button type="button" onclick={() => onOpenZone(zone.id)} class="flex flex-col gap-2 rounded-xl border border-border/50 bg-background p-2.5 text-left hover:bg-(--wash-1)">
            <span class="flex flex-wrap gap-[2px]">
              {#each rows as machine (machine.serverId)}
                {@const fill = tileFill(machine, colorMode)}
                <span
                  class="size-[7px] rounded-[1.5px] {fill ? '' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'}"
                  style:background={fill ?? "transparent"}
                  style:opacity={machineMatches(machine, query) ? 1 : 0.15}
                ></span>
              {/each}
            </span>
            <span class="flex items-center gap-2.5">
              <HostStateIcon state="online" count={summary.answering} size={12} />
              {#if summary.unreachable}<HostStateIcon state="unreachable" count={summary.unreachable} size={12} />{/if}
              <ChevronRight size={12} class="ml-auto text-muted-foreground" />
            </span>
          </button>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each rows as machine (machine.serverId)}
              <li>
                <button
                  type="button"
                  onclick={() => onSelect(machine.serverId)}
                  onmouseenter={() => onPoint(machine.serverId)}
                  onmouseleave={() => onPoint(null)}
                  class="flex w-full items-center gap-2.5 overflow-hidden rounded-xl border border-border/60 bg-background py-2 pr-3 pl-2 text-left
                    {selectedId === machine.serverId ? 'outline-2 outline-offset-2 outline-(--solus-status-running)/60' : ''}"
                  style:opacity={machineMatches(machine, query) ? 1 : 0.35}
                >
                  <FleetLoadRing cpu={machine.cpu} tone={toneOf(machine.state)}>
                    <HostOperatingSystemIcon os={machine.os} managed={machine.isManaged} size={13} />
                  </FleetLoadRing>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-[0.8125rem] font-medium">{machine.label}</span>
                    <HostStateIcon state={machine.state} count={machine.state === "running" ? machine.sessions : undefined} size={12} />
                  </span>
                  {#if machine.latencyMs !== null}<span class="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">{machine.latencyMs} ms</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
</div>
