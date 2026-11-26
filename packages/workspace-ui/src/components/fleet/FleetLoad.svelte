<script lang="ts">
  import * as Tooltip from "../ui/tooltip";
  import { highCount, loadPoints, typicalLoad, type FleetMachine } from "./lib/fleet-model";

  /** The load of the fleet: every host that answers
   *  as one dot, CPU across and memory up. The bands are the levels (medium from
   *  60%, high from 80%, on either reading); a terracotta dot runs sessions, and
   *  a bigger one runs more. The busiest are named. Each dot opens its host.
   *  Above the map, in place of the summary cells. */
  interface Props {
    machines: FleetMachine[];
    onOpen: (serverId: string) => void;
    /** Shows every host with its numbers, in the List view. */
    onShowAll: () => void;
  }

  let { machines, onOpen, onShowAll }: Props = $props();
  const points = $derived(loadPoints(machines));
  const typicalCpu = $derived(typicalLoad(points.map((point) => point.machine), "cpu"));
  const typicalMemory = $derived(typicalLoad(points.map((point) => point.machine), "memory"));
  const high = $derived(highCount(points));
  const sessions = $derived(machines.reduce((sum, machine) => sum + machine.sessions, 0));
  const busyHosts = $derived(machines.filter((machine) => machine.sessions > 0).length);
  /** Hosts that answer: until their first readings come back, the plot says it is reading, at its full height, so nothing below it moves. */
  const answering = $derived(machines.filter((machine) => machine.state === "running" || machine.state === "idle").length);
</script>

<section class="flex flex-col gap-3 rounded-xl border border-border/60 bg-background px-4 py-3" aria-label="Load">
  <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <h3 class="text-chrome-dense font-medium text-foreground">Load <span class="font-normal text-(--solus-text-tertiary)">· {points.length} {points.length === 1 ? "host" : "hosts"} that answer</span></h3>
    <p class="text-chrome-dense text-(--solus-text-tertiary) tabular-nums">
      {sessions} {sessions === 1 ? "session" : "sessions"} running on {busyHosts} of {machines.length} {machines.length === 1 ? "host" : "hosts"}{#if typicalCpu !== null}{` · typical CPU ${typicalCpu}%`}{/if}{#if typicalMemory !== null}{`, memory ${typicalMemory}%`}{/if}{#if high}{" · "}<span class="text-(--solus-status-error)">{high} high</span>{/if}
    </p>
  </div>

  <p class="-mb-1 pl-1 text-[0.6875rem] text-(--solus-text-tertiary)">Memory ↑</p>
  <div class="grid grid-cols-[2.25rem_1fr] grid-rows-[1fr_1.25rem] gap-x-1">
    <div class="relative text-[0.625rem] text-(--solus-text-tertiary) tabular-nums" aria-hidden="true">
      {#each [0, 25, 50, 75, 100] as tick (tick)}
        <span class="absolute right-1 translate-y-1/2" style:bottom="{tick}%">{tick}%</span>
      {/each}
    </div>
    <div class="relative h-56 rounded-md border border-border/60">
      <!-- The levels on either reading: medium from 60%, high from 80%. Grid lines at each quarter. -->
      <div class="absolute inset-0 overflow-hidden rounded-md" aria-hidden="true">
        <div class="absolute inset-y-0 right-0 left-[60%] bg-(--warning)/7"></div>
        <div class="absolute inset-x-0 top-0 h-[40%] bg-(--warning)/7"></div>
        <div class="absolute inset-y-0 right-0 left-[80%] bg-(--solus-status-error)/8"></div>
        <div class="absolute inset-x-0 top-0 h-[20%] bg-(--solus-status-error)/8"></div>
        {#each [25, 50, 75] as tick (tick)}
          <div class="absolute inset-y-0 w-px bg-border/50" style:left="{tick}%"></div>
          <div class="absolute inset-x-0 h-px bg-border/50" style:bottom="{tick}%"></div>
        {/each}
      </div>
      {#if !points.length}
        <p role="status" class="absolute inset-0 grid place-items-center text-chrome-dense text-(--solus-text-tertiary)">
          {answering ? `Reading the load of ${answering} ${answering === 1 ? "host" : "hosts"}…` : "No host answers now."}
        </p>
      {/if}
      <!-- The quietest first, so a busy host's dot is on top. -->
      {#each [...points].reverse() as point (point.machine.serverId)}
        <Tooltip.Root delayDuration={100}>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                aria-label={point.label}
                onclick={() => onOpen(point.machine.serverId)}
                class="absolute -translate-x-1/2 translate-y-1/2 rounded-full ring-[1.5px] ring-background outline-none hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring {point.machine.sessions ? 'bg-(--solus-status-running)' : 'bg-(--solus-text-tertiary)'}"
                style:left="{point.cpu}%"
                style:bottom="{point.memory}%"
                style:width="{point.radius * 2}px"
                style:height="{point.radius * 2}px"
              ></button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content value={point.label} />
        </Tooltip.Root>
        {#if point.isNamed}
          <span
            aria-hidden="true"
            class="pointer-events-none absolute translate-y-1/2 text-[0.6875rem] whitespace-nowrap text-(--solus-text-secondary) {point.cpu > 70 ? '-translate-x-full pr-2.5' : 'pl-2.5'}"
            style:left="{point.cpu}%"
            style:bottom="{point.memory}%"
          >{point.machine.label}</span>
        {/if}
      {/each}
    </div>
    <div></div>
    <div class="relative text-[0.625rem] text-(--solus-text-tertiary) tabular-nums" aria-hidden="true">
      {#each [0, 25, 50, 75, 100] as tick (tick)}
        <span class="absolute top-1 {tick === 0 ? '' : tick === 100 ? '-translate-x-full' : '-translate-x-1/2'}" style:left="{tick}%">{tick}%</span>
      {/each}
      <span class="absolute top-1 left-[87.5%] -translate-x-1/2 text-[0.6875rem]">CPU →</span>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-(--solus-text-tertiary)">
    <span class="flex items-center gap-1"><span class="size-2 rounded-full bg-(--solus-status-running)"></span>Runs sessions (bigger: more)</span>
    <span class="flex items-center gap-1"><span class="size-1.5 rounded-full bg-(--solus-text-tertiary)"></span>Idle</span>
    <span class="flex items-center gap-1"><span class="size-2.5 rounded-sm bg-(--warning)/25"></span>Medium, 60–80%</span>
    <span class="flex items-center gap-1"><span class="size-2.5 rounded-sm bg-(--solus-status-error)/25"></span>High, 80% or more</span>
    <button type="button" onclick={onShowAll} class="ml-auto text-(--solus-text-secondary) underline-offset-2 hover:text-foreground hover:underline">Every host with its numbers, in List</button>
  </div>
</section>
