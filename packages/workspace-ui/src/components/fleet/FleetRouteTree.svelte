<script lang="ts">
  import { ChevronRight, Laptop, Plus, RotateCw } from "@lucide/svelte";
  import * as Tooltip from "../ui/tooltip";
  import FleetStatusLine from "./FleetStatusLine.svelte";
  import RouteKindIcon from "./RouteKindIcon.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { isZoneFull, routeInUseLabel, machineMatches, machinesByZone, rollup, tileFill, toneOf, ZONES, type FleetMachine, type FleetZoneId, type TileColorMode, type ZoneAnswers } from "./lib/fleet-model";

  /** The map in a narrow pane (D4): the same routes as a tree, with this device
   *  at the top. A full zone is one row of small tiles that opens the zone. The
   *  found machines (D7) are one row at the end, which opens the Add page. A
   *  machine known only through a link is a dashed row under your machines
   *  that connects this device. */
  interface Props {
    machines: FleetMachine[];
    colorMode: TileColorMode;
    query: string;
    foundCount: number;
    /** Whether each zone's hosts are read yet: a zone not read says so, with Retry when its read failed. */
    answers: ZoneAnswers;
    onRetry: (zone: FleetZoneId) => void;
    onPoint: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
    onOpenZone: (zone: FleetZoneId) => void;
    onAddFound: () => void;
  }

  let { machines, colorMode, query, foundCount, answers, onRetry, onPoint, onOpen, onOpenZone, onAddFound }: Props = $props();

  const byZone = $derived(machinesByZone(machines));
  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
</script>

<div class="flex flex-col gap-1 p-3">
  <div data-host-id={device?.serverId} class="flex items-center gap-2.5 rounded-xl border border-border/70 bg-background py-2 pr-3 pl-2">
    <FleetLoadRing cpu={device?.cpu ?? null} tone="ok"><Laptop size={13} /></FleetLoadRing>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-[0.8125rem] font-medium">{device?.label ?? "This browser"}</span>
      <span class="text-chrome-dense text-muted-foreground">This device</span>
    </span>
    {#if device?.sessions}<HostStateIcon state="running" count={device.sessions} />{/if}
  </div>
  <div class="px-1 pt-2"><FleetStatusLine {machines} /></div>
  <ul>
    {#each ZONES.filter((zone) => byZone[zone.id].length || answers[zone.id] !== "ready") as zone (zone.id)}
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
                  data-host-id={machine.serverId}
                  onclick={() => onOpen(machine.serverId)}
                  onmouseenter={() => onPoint(machine.serverId)}
                  onmouseleave={() => onPoint(null)}
                  class="flex w-full items-center gap-2.5 overflow-hidden rounded-xl border border-border/60 bg-background py-2 pr-3 pl-2 text-left hover:bg-(--wash-1)"
                  style:opacity={machineMatches(machine, query) ? 1 : 0.35}
                >
                  <FleetLoadRing cpu={machine.cpu} tone={toneOf(machine.state)}>
                    <HostOperatingSystemIcon os={machine.os} managed={machine.isManaged} size={13} />
                  </FleetLoadRing>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-[0.8125rem] font-medium">{machine.label}</span>
                    <HostStateIcon state={machine.state} label={machine.problem?.label} count={machine.state === "running" ? machine.sessions : undefined} size={12} />
                  </span>
                  {#if machine.routeInUse && machine.routeInUse.kind !== "tunnel"}
                    {@const route = machine.routeInUse}
                    <Tooltip.Root delayDuration={150}>
                      <Tooltip.Trigger>
                        {#snippet child({ props })}
                          <span
                            {...props}
                            role="img"
                            aria-label={routeInUseLabel(route)}
                            class="shrink-0 {route.phase === 'refused' ? 'text-(--solus-status-error)' : route.phase === 'connecting' ? 'text-(--warning)' : 'text-muted-foreground'}"
                          ><RouteKindIcon kind={route.kind} size={12} /></span>
                        {/snippet}
                      </Tooltip.Trigger>
                      <Tooltip.Content value={routeInUseLabel(route)} />
                    </Tooltip.Root>
                  {/if}
                  {#if machine.latencyMs !== null}<span class="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">{machine.latencyMs} ms</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if answers[zone.id] === "loading"}
          <p role="status" class="truncate px-1 py-2 text-chrome-dense text-muted-foreground">
            {zone.id === "own" ? "Reading your host list…" : `Reading ${zone.label}…`}
          </p>
        {:else if answers[zone.id] === "failed"}
          <button
            type="button"
            onclick={() => onRetry(zone.id)}
            class="flex items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--solus-status-error)/40 py-2 pr-3 pl-2 text-left text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            <span class="grid size-[30px] shrink-0 place-items-center"><RotateCw size={13} /></span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate text-[0.8125rem] font-medium text-foreground">{zone.id === "own" ? "Host list not read" : `${zone.label} not read`}</span>
              <span class="truncate text-chrome-dense">Select to retry</span>
            </span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if foundCount}
    <button
      type="button"
      onclick={onAddFound}
      class="mt-2 flex h-[3.25rem] items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--hairline-strongest) pr-3 pl-2 text-left text-muted-foreground hover:border-foreground/30 hover:text-foreground"
    >
      <span class="grid size-[30px] shrink-0 place-items-center"><Plus size={13} /></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-[0.8125rem] font-medium">{foundCount} found nearby</span>
        <span class="truncate text-chrome-dense">Not added yet</span>
      </span>
    </button>
  {/if}
</div>
