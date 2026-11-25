<script lang="ts">
  import { ChevronLeft, Power } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import FleetTile from "./FleetTile.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { groupsOf, MAP_HEIGHT, rollup, type FleetMachine, type FleetZone, type TileColorMode } from "./lib/fleet-model";

  /** One full zone, opened over the map: a group for each organization or owner,
   *  a larger tile for each host, and the zone's bulk actions. A tile opens its
   *  host, and each tile is a Tab stop. */
  interface Props {
    zone: FleetZone;
    machines: FleetMachine[];
    colorMode: TileColorMode;
    query: string;
    focusId: string | null;
    onPoint: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
    onBack: () => void;
  }

  let { zone, machines, colorMode, query, focusId, onPoint, onOpen, onBack }: Props = $props();

  const summary = $derived(rollup(machines));
  const unreachable = $derived(machines.filter((machine) => machine.state === "unreachable").map((machine) => machine.serverId));
  const withUpdate = $derived(machines.filter((machine) => machine.hasUpdate).map((machine) => machine.serverId));
  const stopped = $derived(machines.filter((machine) => machine.state === "stopped" && machine.hasManagedCompute).map((machine) => machine.serverId));
</script>

<div class="flex flex-col gap-5 p-5" style:min-height="{MAP_HEIGHT}rem">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2">
      <button type="button" onclick={onBack} aria-label="Back to the map" class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-(--wash-3) hover:text-foreground">
        <ChevronLeft size={15} />
      </button>
      <div class="flex min-w-0 flex-col">
        <h3 class="text-workspace-chrome font-medium">{zone.label}</h3>
        <p class="flex items-center gap-2.5">
          <HostStateIcon state="online" count={summary.answering} size={12} />
          {#if summary.reconnecting}<HostStateIcon state="reconnecting" count={summary.reconnecting} size={12} />{/if}
          {#if summary.unreachable}<HostStateIcon state="unreachable" count={summary.unreachable} size={12} />{/if}
          {#if summary.stopped}<HostStateIcon state="stopped" count={summary.stopped} size={12} />{/if}
        </p>
      </div>
    </div>
    <div class="flex flex-wrap gap-1.5">
      {#if unreachable.length}<Button variant="ghost" size="sm" onclick={() => fleetStore.retryHosts(unreachable)}>Retry {unreachable.length}</Button>{/if}
      {#if withUpdate.length}<Button variant="ghost" size="sm" onclick={() => fleetStore.updateHosts(withUpdate)}>Update {withUpdate.length}</Button>{/if}
      {#if stopped.length}<Button variant="outline" size="sm" onclick={() => fleetStore.startHosts(stopped)}><Power size={13} />Start {stopped.length}</Button>{/if}
    </div>
  </div>
  <div class="@container">
    <div class="grid gap-x-10 gap-y-6 @[40rem]:grid-cols-2">
      {#each groupsOf(machines) as { group, machines: grouped } (group)}
        {@const groupSummary = rollup(grouped)}
        <section class="flex flex-col gap-3 border-t border-border/40 pt-4">
          <div class="flex items-baseline justify-between gap-3">
            <h4 class="truncate text-[0.8125rem] font-medium">{group ?? zone.label}</h4>
            <p class="shrink-0 text-chrome-dense text-muted-foreground tabular-nums">
              CPU {groupSummary.averageCpu ?? "—"}% · {groupSummary.medianLatencyMs ?? "—"} ms
            </p>
          </div>
          <div class="flex flex-wrap gap-[3px]">
            {#each grouped as machine (machine.serverId)}
              <FleetTile
                {machine}
                {colorMode}
                size={14}
                {query}
                isFocused={focusId === machine.serverId}
                isSelected={false}
                isPicked={false}
                isCurrent
                {onPoint}
                onSelect={(serverId) => onOpen(serverId)}
              />
            {/each}
          </div>
          <p class="flex items-center gap-2.5">
            <HostStateIcon state="online" count={groupSummary.answering} size={12} />
            {#if groupSummary.sessions}<HostStateIcon state="running" count={groupSummary.sessions} size={12} />{/if}
            {#if groupSummary.unreachable}<HostStateIcon state="unreachable" count={groupSummary.unreachable} size={12} />{/if}
          </p>
        </section>
      {/each}
    </div>
  </div>
</div>
