<script lang="ts">
  import { ChevronRight, FoldVertical, KeyRound, Laptop, Plus, RotateCw, Terminal, UnfoldVertical } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import FleetMapCard from "./FleetMapCard.svelte";
  import FleetReachLines from "./FleetReachLines.svelte";
  import FleetRouteWires from "./FleetRouteWires.svelte";
  import FleetStatusLine from "./FleetStatusLine.svelte";
  import FleetTile from "./FleetTile.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import type { FoundMachine } from "./lib/discover";
  import { CARD_HEIGHT, groupsOf, machineMatches, rollup, toneOf, ZONE_HEADER, type AddWay, type FleetMachine, type FleetZoneId, type MapLayout, type Point, type TileColorMode, type ZoneSlot } from "./lib/fleet-model";
  import type { ReachPath } from "./lib/fleet-reach";
  import type { FannedRoutes } from "./lib/fleet-routes";

  /** What the map draws, in the map's own coordinates: this device at the center,
   *  a zone for your machines, for Solus Cloud, and for the hosts shared with you,
   *  the routes to each host, and the lines between your hosts. The frame around
   *  it (`FleetMap`) scales and pans it. A zone too full for cards shows tiles, and
   *  can open in place to show a card for each host. */
  interface Props {
    map: MapLayout;
    /** Every host, this device among them. */
    machines: FleetMachine[];
    colorMode: TileColorMode;
    query: string;
    focusId: string | null;
    isLit: (serverId: string) => boolean;
    selectedId: string | null;
    pickedIds: ReadonlySet<string>;
    selectedEdgeId: string | null;
    /** The one host Tab reaches. */
    currentId: string | null;
    wires: ReadonlyMap<string, FannedRoutes>;
    reachPaths: ReachPath[];
    /** The host whose handle is being dragged: it keeps its handle and a ring. */
    dragSourceId: string | null;
    dropStateOf: (serverId: string) => "ok" | "no" | null;
    /** The found machine a dragged handle is over: a drop there adds it. */
    dropFoundKey: string | null;
    canIntroduce: (serverId: string) => boolean;
    labelOf: (serverId: string) => string;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string, isAdding: boolean) => void;
    onOpenZone: (zone: FleetZoneId) => void;
    onToggleZone: (zone: FleetZoneId) => void;
    onAdd: (way: AddWay) => void;
    onStart: (serverId: string) => void;
    onPointFound: (key: string | null) => void;
    onRetry: (zone: FleetZoneId) => void;
    onHandleDown: (event: PointerEvent, serverId: string) => void;
    onSelectEdge: (edgeId: string) => void;
  }

  let {
    map, machines, colorMode, query, focusId, isLit, selectedId, pickedIds, selectedEdgeId, currentId, wires, reachPaths, dragSourceId, dropStateOf, dropFoundKey, canIntroduce, labelOf,
    onPoint, onSelect, onOpenZone, onToggleZone, onAdd, onStart, onPointFound, onRetry, onHandleDown, onSelectEdge,
  }: Props = $props();

  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
  const slotKey = (slot: ZoneSlot) => `${slot.kind}:${slot.kind === "host" ? slot.machine.serverId : slot.kind === "found" ? slot.machine.key : ""}`;
  const addCards = {
    cloud: { title: "New machine", subtitle: "Ready in a minute" },
    pair: { title: "Pair a machine", subtitle: "With the code it shows" },
  } satisfies Record<Extract<ZoneSlot, { kind: "add" }>["way"], { title: string; subtitle: string }>;
  const isGroupLit = (hosts: FleetMachine[]) => !focusId || hosts.some((machine) => isLit(machine.serverId));
</script>

<!-- Zones, each as tall as its rows. A full zone holds one tile for each host, by organization or owner. -->
{#each map.zones as { zone, hosts, isFull, isOpen, moreFound, box } (zone.id)}
  {@const summary = rollup(hosts)}
  <div
    class="absolute flex flex-col overflow-hidden rounded-xl border border-border/50 bg-background transition-opacity duration-300 motion-reduce:transition-none"
    style:left="{box.x}%"
    style:top="{box.y}%"
    style:width="{box.w}%"
    style:height="{box.h}%"
    style:padding-inline="{map.zoneInset}%"
    style:opacity={isGroupLit(hosts) ? 1 : 0.6}
  >
    <div class="flex shrink-0 items-center gap-1 px-1" style:height="{ZONE_HEADER}rem">
      <p class="min-w-0 flex-1 truncate text-chrome-dense font-medium text-(--solus-text-secondary)">{zone.label}</p>
      <!-- The found machines the zone has no row for: the Add page lists them all. -->
      {#if moreFound}
        <button
          type="button"
          onclick={() => onAdd("nearby")}
          title="Found and not on the map. Select to add one."
          class="inline-flex h-[1.1875rem] shrink-0 items-center rounded-md bg-(--wash-3) px-[7px] text-chrome-dense text-(--solus-text-secondary) hover:text-foreground"
        >
          {isFull ? "" : "+"}{moreFound} found
        </button>
      {/if}
      {#if isFull || isOpen}
        <button
          type="button"
          onclick={() => onToggleZone(zone.id)}
          aria-label={isOpen ? `Fold ${zone.label}` : `Show every host of ${zone.label} on the map`}
          title={isOpen ? "Fold" : "Show each host on the map"}
          class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-(--wash-3) hover:text-foreground"
        >
          {#if isOpen}<FoldVertical size={13} />{:else}<UnfoldVertical size={13} />{/if}
        </button>
        <button
          type="button"
          onclick={() => onOpenZone(zone.id)}
          aria-label="Open {zone.label}"
          class="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-(--wash-3) hover:text-foreground"
        >
          <ChevronRight size={13} />
        </button>
      {/if}
    </div>
    {#if isFull}
      {@const groups = groupsOf(hosts)}
      <p class="flex shrink-0 items-center gap-2.5 px-1 pb-2.5">
        <HostStateIcon state="online" count={summary.answering} size={12} />
        {#if summary.reconnecting}<HostStateIcon state="reconnecting" count={summary.reconnecting} size={12} />{/if}
        {#if summary.unreachable}<HostStateIcon state="unreachable" count={summary.unreachable} size={12} />{/if}
        {#if summary.stopped}<HostStateIcon state="stopped" count={summary.stopped} size={12} />{/if}
        {#if summary.medianLatencyMs !== null}
          <span class="ml-auto shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums">{summary.medianLatencyMs} ms</span>
        {/if}
      </p>
      <div class="flex min-h-0 flex-col gap-2.5 overflow-hidden px-1">
        {#each groups as { group, machines: grouped } (group)}
          <div class="flex flex-col gap-1">
            {#if groups.length > 1}
              <p class="flex justify-between gap-2 text-[0.6875rem] text-muted-foreground tabular-nums">
                <span class="truncate">{group ?? "Other"}</span><span class="shrink-0">{rollup(grouped).answering} of {grouped.length}</span>
              </p>
            {/if}
            <div class="flex flex-wrap gap-[3px]">
              {#each grouped as machine (machine.serverId)}
                <FleetTile
                  {machine}
                  {colorMode}
                  size={hosts.length > 60 ? 8 : 11}
                  {query}
                  isFocused={focusId === machine.serverId}
                  isSelected={selectedId === machine.serverId}
                  isPicked={pickedIds.has(machine.serverId)}
                  isCurrent={currentId === machine.serverId}
                  dropState={dropStateOf(machine.serverId)}
                  {onPoint}
                  {onSelect}
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/each}

<FleetRouteWires {map} {wires} {isLit} {focusId} />
<FleetReachLines paths={reachPaths} {selectedEdgeId} {focusId} {labelOf} {onSelectEdge} />

<!-- The status of the fleet on one line, above this device, where no line passes. -->
<div class="absolute z-20 w-max -translate-x-1/2 -translate-y-full" style:left="{map.hub.x}%" style:top="calc({map.hub.y}% - 2.5rem)">
  <FleetStatusLine {machines} />
</div>

<!-- This device: the center. A web client has no host of its own, so its center is the browser. -->
<div class="absolute z-20 -translate-1/2" style:left="{map.hub.x}%" style:top="{map.hub.y}%" style:width="{map.hub.w}%">
  {#if device}
    {@const dropState = dropStateOf(device.serverId)}
    <!-- The outline of a pick or a drop is on the wrapper: the button's own outline stays off for its focus ring. -->
    <div
      class="group relative rounded-xl
        {dropState === 'ok' ? 'outline-2 outline-offset-2 outline-(--success)' : dropState === 'no' ? 'outline-2 outline-offset-2 outline-dashed outline-(--solus-status-error)' : pickedIds.has(device.serverId) ? 'outline-2 outline-offset-2 outline-dashed outline-foreground' : ''}"
      data-host-id={device.serverId}
    >
      <button
        type="button"
        data-fleet-stop
        tabindex={currentId === device.serverId ? 0 : -1}
        aria-pressed={selectedId === device.serverId}
        aria-label="{device.label}, this device"
        onclick={(event) => onSelect(device.serverId, event.shiftKey)}
        onmouseenter={() => onPoint(device.serverId)}
        onmouseleave={() => onPoint(null)}
        onfocus={() => onPoint(device.serverId)}
        onblur={() => onPoint(null)}
        class="flex h-[3.75rem] w-full items-center gap-2.5 overflow-hidden rounded-xl border border-border/70 bg-card pr-3 pl-2.5 text-left shadow-[shadow:var(--solus-card-shadow-collapsed)] outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring dark:shadow-none
          {selectedId === device.serverId || dragSourceId === device.serverId ? 'ring-2 ring-foreground/70' : ''}"
      >
        <FleetLoadRing cpu={device.cpu} tone={toneOf(device.state)} size={34}><Laptop size={14} /></FleetLoadRing>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-[0.8125rem] font-medium">{device.label}</span>
          <span class="flex items-center justify-between gap-1.5 text-chrome-dense text-muted-foreground">
            <span class="truncate">This device</span>
            {#if device.sessions}<HostStateIcon state="running" count={device.sessions} size={11} />{/if}
          </span>
        </span>
      </button>
      {#if canIntroduce(device.serverId)}
        <button
          type="button"
          tabindex="-1"
          data-handle-side="bottom"
          aria-label="Drag onto another host to introduce {device.label} to it, or onto a found machine to add it"
          title="Drag onto another host to introduce them, or onto a found machine to add it"
          onpointerdown={(event) => onHandleDown(event, device.serverId)}
          class="absolute -bottom-2.5 left-1/2 z-20 grid size-5 -translate-x-1/2 cursor-crosshair touch-none place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground motion-reduce:transition-none pointer-coarse:opacity-100
            {dragSourceId === device.serverId ? 'opacity-100' : ''}"
        ><Plus size={11} /></button>
      {/if}
    </div>
  {:else}
    <div class="flex h-[3.75rem] items-center gap-2.5 overflow-hidden rounded-xl border border-border/70 bg-card pr-3 pl-2.5 shadow-[shadow:var(--solus-card-shadow-collapsed)] dark:shadow-none">
      <span class="grid size-[34px] shrink-0 place-items-center text-muted-foreground"><Laptop size={14} /></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-[0.8125rem] font-medium">This browser</span>
        <span class="truncate text-chrome-dense text-muted-foreground">This device</span>
      </span>
    </div>
  {/if}
</div>

<!-- The rows of a zone with room: a card for each host, then room to grow. -->
{#each map.zones as { zone, rows } (zone.id)}
  {#each rows as { slot, at } (slotKey(slot))}
    {#if slot.kind === "host"}
      <FleetMapCard
        machine={slot.machine}
        {at}
        width={map.cardWidth}
        isDimmed={!machineMatches(slot.machine, query)}
        isFaded={!isLit(slot.machine.serverId) && !pickedIds.has(slot.machine.serverId) && selectedId !== slot.machine.serverId}
        isSelected={selectedId === slot.machine.serverId}
        isPicked={pickedIds.has(slot.machine.serverId)}
        isCurrent={currentId === slot.machine.serverId}
        canIntroduce={canIntroduce(slot.machine.serverId)}
        dropState={dropStateOf(slot.machine.serverId)}
        isDragSource={dragSourceId === slot.machine.serverId}
        {onPoint}
        {onSelect}
        {onStart}
        {onHandleDown}
      />
    {:else if slot.kind === "found"}
      {@render foundCard(slot.machine, at)}
    {:else if slot.kind === "add"}
      {@render addCard(slot.way, at)}
    {:else if slot.kind === "unread"}
      {@render unreadCard(zone.id, zone.label, slot.state, at)}
    {:else if slot.kind === "more"}
      <button
        type="button"
        onclick={() => onOpenZone(zone.id)}
        class="absolute z-10 flex -translate-1/2 items-center justify-center gap-1.5 overflow-hidden rounded-xl border border-dashed border-(--hairline-strongest) text-chrome-dense whitespace-nowrap text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        style:left="{at.x}%"
        style:top="{at.y}%"
        style:width="{map.cardWidth}%"
        style:height="{CARD_HEIGHT}rem"
      >
        {slot.count} more in {zone.label}<ChevronRight size={12} />
      </button>
    {:else}
      <p
        class="absolute flex -translate-1/2 items-center justify-center overflow-hidden text-chrome-dense whitespace-nowrap text-muted-foreground"
        style:left="{at.x}%"
        style:top="{at.y}%"
        style:width="{map.cardWidth}%"
        style:height="{CARD_HEIGHT}rem"
      >
        No shared hosts
      </p>
    {/if}
  {/each}
{/each}

<!-- Room to grow is a dashed outline, not a card: it is not a host yet. -->
{#snippet foundCard(machine: FoundMachine, at: Point)}
  <button
    type="button"
    data-found-key={machine.key}
    onclick={() => onAdd("nearby")}
    onmouseenter={() => onPointFound(machine.key)}
    onmouseleave={() => onPointFound(null)}
    onfocus={() => onPointFound(machine.key)}
    onblur={() => onPointFound(null)}
    class="group absolute z-10 flex -translate-1/2 items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--hairline-strongest) pl-2 text-left text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-card motion-reduce:transition-none pr-3
      {dropFoundKey === machine.key ? 'bg-card outline-2 outline-offset-2 outline-(--success)' : ''}"
    style:left="{at.x}%"
    style:top="{at.y}%"
    style:width="{map.cardWidth}%"
    style:height="{CARD_HEIGHT}rem"
  >
    <span class="grid size-[30px] shrink-0 place-items-center">
      {#if machine.kind === "ssh"}<Terminal size={13} />{:else}<HostOperatingSystemIcon os={machine.os} size={13} />{/if}
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="truncate text-[0.8125rem] font-medium text-foreground">{machine.name}</span>
      <span class="truncate text-chrome-dense">Found nearby</span>
    </span>
    <Plus size={13} class="shrink-0 group-hover:text-foreground" />
  </button>
{/snippet}

<!-- A zone whose hosts are not read yet: nothing is kept from an earlier start. -->
{#snippet unreadCard(zoneId: FleetZoneId, label: string, state: "loading" | "failed", at: Point)}
  {#if state === "loading"}
    <p
      class="absolute flex -translate-1/2 items-center justify-center overflow-hidden text-chrome-dense whitespace-nowrap text-muted-foreground"
      style:left="{at.x}%"
      style:top="{at.y}%"
      style:width="{map.cardWidth}%"
      style:height="{CARD_HEIGHT}rem"
      role="status"
    >
      {zoneId === "own" ? "Reading your host list…" : `Reading ${label}…`}
    </p>
  {:else}
    <button
      type="button"
      onclick={() => onRetry(zoneId)}
      class="group absolute z-10 flex -translate-1/2 items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--solus-status-error)/40 pr-3 pl-2 text-left text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-card motion-reduce:transition-none"
      style:left="{at.x}%"
      style:top="{at.y}%"
      style:width="{map.cardWidth}%"
      style:height="{CARD_HEIGHT}rem"
    >
      <span class="grid size-[30px] shrink-0 place-items-center"><RotateCw size={13} /></span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[0.8125rem] font-medium text-foreground">{zoneId === "own" ? "Host list not read" : `${label} not read`}</span>
        <span class="truncate text-chrome-dense">Select to retry</span>
      </span>
    </button>
  {/if}
{/snippet}

{#snippet addCard(way: Extract<ZoneSlot, { kind: "add" }>["way"], at: Point)}
  <button
    type="button"
    onclick={() => onAdd(way)}
    class="absolute z-10 flex -translate-1/2 items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--hairline-strongest) pr-3 pl-2 text-left text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-card hover:text-foreground motion-reduce:transition-none"
    style:left="{at.x}%"
    style:top="{at.y}%"
    style:width="{map.cardWidth}%"
    style:height="{CARD_HEIGHT}rem"
  >
    <span class="grid size-[30px] shrink-0 place-items-center">
      {#if way === "pair"}<KeyRound size={13} />{:else}<Plus size={13} />{/if}
    </span>
    <span class="flex min-w-0 flex-col gap-0.5">
      <span class="truncate text-[0.8125rem] font-medium">{addCards[way].title}</span>
      <span class="truncate text-chrome-dense">{addCards[way].subtitle}</span>
    </span>
  </button>
{/snippet}
