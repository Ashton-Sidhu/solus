<script lang="ts">
  import { ChevronRight, KeyRound, Laptop, Link2, Plus, RotateCw, Terminal } from "@lucide/svelte";
  import * as Tooltip from "../ui/tooltip";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import FleetMapCard from "./FleetMapCard.svelte";
  import FleetTile from "./FleetTile.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import FleetStatusLine from "./FleetStatusLine.svelte";
  import RouteKindIcon from "./RouteKindIcon.svelte";
  import type { FoundMachine } from "./lib/discover";
  import {
    CARD_HEIGHT,
    groupsOf,
    linkPath,
    MAP_HEIGHT,
    machineMatches,
    machinesByZone,
    mapLayout,
    rollup,
    routeInUseLabel,
    toneOf,
    trafficOf,
    trafficText,
    trafficWidth,
    travelSeconds,
    ZONE_HEADER,
    type AddWay,
    type FleetMachine,
    type FleetTone,
    type FleetZoneId,
    type Point,
    type TileColorMode,
    type ZoneAnswers,
    type ZoneSlot,
  } from "./lib/fleet-model";

  /**
   * The map (docs/plans/host-fleet.md D4): this device at the center, a zone for
   * your machines, for Solus Cloud, and for the hosts shared with you, and a link
   * to each host, or one link for a zone too full for cards.
   * Its only continuous motion is the approved light on busy links (D5), paused
   * by `isLive`. Each host's line shows the mark of the route this device is
   * on, or tries, at its card, and is as wide as its traffic (D13). The status
   * of the fleet is one line above this device.
   */
  interface Props {
    machines: FleetMachine[];
    found: FoundMachine[];
    /** Whether each zone's hosts are read yet: a zone not read says so, with Retry when its read failed. */
    answers: ZoneAnswers;
    colorMode: TileColorMode;
    query: string;
    focusId: string | null;
    isLive: boolean;
    onPoint: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
    onOpenZone: (zone: FleetZoneId) => void;
    onAdd: (way: AddWay) => void;
    onStart: (serverId: string) => void;
    /** The found machine under the pointer, by its key; null when the pointer leaves it. */
    onPointFound: (key: string | null) => void;
    /** Reads a zone's hosts again after its read failed. */
    onRetry: (zone: FleetZoneId) => void;
  }

  let { machines, found, answers, colorMode, query, focusId, isLive, onPoint, onOpen, onOpenZone, onAdd, onStart, onPointFound, onRetry }: Props = $props();

  /** The map's own box, in px. Its height is `MAP_HEIGHT` rem, so the two give its width in rem. */
  let mapWidth = $state(0);
  let mapHeight = $state(0);

  const map = $derived(mapLayout(machinesByZone(machines), found, mapHeight ? (mapWidth / mapHeight) * MAP_HEIGHT : 0, answers));
  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
  const tunneled = $derived(map.zones.flatMap(({ zone, hosts }) => (zone.isViaTunnel ? hosts : [])));
  const hubPort = $derived({ x: map.hub.x + map.hub.w / 2, y: map.hub.y });
  const tunnelSummary = $derived(rollup(tunneled));
  /** The tunnel carries the traffic of every host past it. */
  const tunnelWidth = $derived(trafficWidth(trafficOf(tunneled)));
  /** The words of a route mark: the route, how it goes, and its traffic (D13). */
  const routeMarkLabel = (machine: FleetMachine, route: NonNullable<FleetMachine["routeInUse"]>) => {
    const traffic = trafficText(machine.traffic);
    return traffic ? `${routeInUseLabel(route)} · ${traffic}` : routeInUseLabel(route);
  };

  const isZoneLit = (hosts: FleetMachine[]) => !focusId || hosts.some((machine) => machine.serverId === focusId);
  const isLit = (serverId: string) => !focusId || focusId === serverId;
  const slotKey = (slot: ZoneSlot) => `${slot.kind}:${slot.kind === "host" ? slot.machine.serverId : slot.kind === "found" ? slot.machine.key : ""}`;
  const addCards = {
    cloud: { title: "New machine", subtitle: "Ready in a minute" },
    pair: { title: "Pair a machine", subtitle: "With the code it shows" },
  } satisfies Record<Extract<ZoneSlot, { kind: "add" }>["way"], { title: string; subtitle: string }>;
  const portColor = {
    ok: "var(--success)",
    warn: "var(--warning)",
    bad: "var(--solus-status-error)",
    off: "var(--solus-status-idle)",
  } satisfies Record<FleetTone, string>;
  const lineColor = (machine: FleetMachine) => {
    const tone = toneOf(machine.state);
    return tone === "ok" ? "color-mix(in oklch, var(--success) 80%, transparent)" : tone === "off" ? "var(--hairline-strong)" : portColor[tone];
  };
</script>

<div
  class="relative isolate overflow-hidden bg-background bg-[radial-gradient(circle,var(--hairline)_1px,transparent_1px)] [background-size:18px_18px]"
  class:paused={!isLive}
  style:height="{MAP_HEIGHT}rem"
  bind:clientWidth={mapWidth}
  bind:clientHeight={mapHeight}
>
  <!-- Zones, each as tall as its rows. A full zone holds one tile for each host, by organization or owner. -->
  {#each map.zones as { zone, hosts, isFull, moreFound, box } (zone.id)}
    {@const summary = rollup(hosts)}
    <div
      class="absolute flex flex-col overflow-hidden rounded-xl border border-border/50 bg-background transition-opacity duration-300 motion-reduce:transition-none"
      style:left="{box.x}%"
      style:top="{box.y}%"
      style:width="{box.w}%"
      style:height="{box.h}%"
      style:padding-inline="{map.zoneInset}%"
      style:opacity={isZoneLit(hosts) ? 1 : 0.6}
    >
      <div class="flex shrink-0 items-center gap-1.5 px-1" style:height="{ZONE_HEADER}rem">
        <p class="min-w-0 flex-1 truncate text-chrome-dense font-medium text-(--solus-text-secondary)">{zone.label}</p>
        <!-- The found machines the zone has no row for (D7): the Add page lists them all. -->
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
        {#if isFull}
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
                  <FleetTile {machine} {colorMode} size={hosts.length > 60 ? 8 : 11} {query} isFocused={focusId === machine.serverId} {onPoint} {onOpen} />
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <!-- Links: green when connected, the problem's color when not, as wide as their traffic; a terracotta light moves along a link that carries sessions. -->
  <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    {#if tunneled.length}
      <g opacity={isZoneLit(tunneled) ? 1 : 0.35}>
        <path d={linkPath(hubPort, map.tunnel)} fill="none" stroke-width={tunnelWidth} vector-effect="non-scaling-stroke"
          style:stroke={tunnelSummary.answering ? "color-mix(in oklch, var(--success) 80%, transparent)" : "var(--hairline-strong)"} />
        {#if tunnelSummary.sessions}
          <path d={linkPath(hubPort, map.tunnel)} fill="none" stroke-width={tunnelWidth} stroke-linecap="round" vector-effect="non-scaling-stroke"
            class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(tunnelSummary.sessions)}s" />
        {/if}
      </g>
    {/if}
    {#each map.zones as { zone, hosts, isFull, rows, linkStart, port } (zone.id)}
      {#if isFull}
        {@const summary = rollup(hosts)}
        {@const path = linkPath(linkStart, port)}
        {@const width = trafficWidth(trafficOf(hosts))}
        <g opacity={isZoneLit(hosts) ? 1 : 0.35}>
          <path d={path} fill="none" stroke-width={width} vector-effect="non-scaling-stroke"
            style:stroke={summary.answering ? "color-mix(in oklch, var(--success) 80%, transparent)" : "var(--hairline-strong)"} />
          {#if summary.sessions}
            <path d={path} fill="none" stroke-width={width} stroke-linecap="round" vector-effect="non-scaling-stroke"
              class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(summary.sessions)}s" />
          {/if}
        </g>
      {:else}
        {#each hosts as machine, index (machine.serverId)}
          {@const tone = toneOf(machine.state)}
          {@const path = linkPath(linkStart, rows[index]!.port)}
          {@const width = trafficWidth(trafficOf([machine]))}
          <g opacity={isLit(machine.serverId) ? 1 : 0.3}>
            <path d={path} fill="none" vector-effect="non-scaling-stroke"
              stroke-width={width + (focusId === machine.serverId ? 0.75 : 0)}
              stroke-dasharray={machine.routeKind === "forwarded" ? "5 4" : tone === "ok" ? undefined : tone === "off" ? "3 4" : "2 4"}
              class:crawl={tone === "warn"}
              style:stroke={lineColor(machine)} />
            {#if tone === "ok" && machine.sessions}
              <path d={path} fill="none" stroke-width={width} stroke-linecap="round" vector-effect="non-scaling-stroke"
                class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(machine.sessions)}s" />
            {/if}
          </g>
        {/each}
      {/if}
    {/each}
  </svg>

  <!-- Ports: where a link meets its card, or the edge of a full zone. -->
  {#each map.zones as { zone, hosts, isFull, rows, port } (zone.id)}
    {#if isFull}
      <span
        aria-hidden="true"
        class="absolute z-15 size-[5px] -translate-1/2 rounded-full ring-[1.5px] ring-background"
        style:left="{port.x}%"
        style:top="{port.y}%"
        style:background={rollup(hosts).answering ? portColor.ok : portColor.off}
        style:opacity={isZoneLit(hosts) ? 1 : 0.35}
      ></span>
    {:else}
      {#each hosts as machine, index (machine.serverId)}
        {@const cardPort = rows[index]!.port}
        <span
          aria-hidden="true"
          class="absolute z-15 size-[5px] -translate-1/2 rounded-full ring-[1.5px] ring-background"
          style:left="{cardPort.x}%"
          style:top="{cardPort.y}%"
          style:background={portColor[toneOf(machine.state)]}
          style:opacity={isLit(machine.serverId) ? 1 : 0.3}
        ></span>
      {/each}
    {/if}
  {/each}

  <!-- The route of each host, on its line at its card (D13). The tunnel is drawn as its own mark, so a tunneled line needs no name. -->
  {#each map.zones as { zone, hosts, isFull, rows } (zone.id)}
    {#if !isFull}
      {#each hosts as machine, index (machine.serverId)}
        {@const route = machine.routeInUse}
        {@const cardPort = rows[index]!.port}
        {#if route && route.kind !== "tunnel"}
          <Tooltip.Root delayDuration={150}>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <span
                  {...props}
                  role="img"
                  aria-label={routeMarkLabel(machine, route)}
                  class="absolute z-15 grid size-[18px] -translate-y-1/2 place-items-center rounded-full border bg-card transition-opacity duration-300 motion-reduce:transition-none
                    {zone.isViaTunnel ? '-translate-x-[calc(100%+0.375rem)]' : 'translate-x-1.5'}
                    {route.phase === 'refused'
                      ? 'border-(--solus-status-error)/40 text-(--solus-status-error)'
                      : route.phase === 'connecting'
                        ? 'border-(--warning)/40 text-(--warning)'
                        : 'border-border/70 text-muted-foreground'}"
                  style:left="{cardPort.x}%"
                  style:top="{cardPort.y}%"
                  style:opacity={isLit(machine.serverId) ? 1 : 0.3}
                ><RouteKindIcon kind={route.kind} size={10} /></span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content value={routeMarkLabel(machine, route)} />
          </Tooltip.Root>
        {/if}
      {/each}
    {/if}
  {/each}

  {#if tunneled.length}
    <span
      role="img"
      aria-label="Solus tunnel"
      title="Solus tunnel"
      class="absolute z-10 grid size-[22px] -translate-1/2 place-items-center rounded-full border bg-card
        {tunnelSummary.answering ? 'border-(--success)/40 text-(--success)' : 'border-border text-muted-foreground'}"
      style:left="{map.tunnel.x}%"
      style:top="{map.tunnel.y}%"
    >
      <Link2 size={11} />
    </span>
  {/if}

  <!-- The status of the fleet on one line, above this device, where no line passes (D13). -->
  <div class="absolute z-20 w-max -translate-x-1/2 -translate-y-full" style:left="{map.hub.x}%" style:top="calc({map.hub.y}% - 2.5rem)">
    <FleetStatusLine {machines} />
  </div>

  <!-- This device: the center. A web client has no host of its own, so its center is the browser. -->
  <div class="absolute z-20 -translate-1/2" style:left="{map.hub.x}%" style:top="{map.hub.y}%" style:width="{map.hub.w}%">
    {#if device}
      <button
        type="button"
        data-host-id={device.serverId}
        onclick={() => onOpen(device.serverId)}
        onmouseenter={() => onPoint(device.serverId)}
        onmouseleave={() => onPoint(null)}
        onfocus={() => onPoint(device.serverId)}
        onblur={() => onPoint(null)}
        class="flex h-[3.75rem] w-full items-center gap-2.5 overflow-hidden rounded-xl border border-border/70 bg-card pr-3 pl-2.5 text-left shadow-[shadow:var(--solus-card-shadow-collapsed)] hover:border-foreground/25 dark:shadow-none"
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
          {onPoint}
          {onOpen}
          {onStart}
        />
      {:else if slot.kind === "found"}
        {@render foundCard(slot.machine, at)}
      {:else if slot.kind === "add"}
        {@render addCard(slot.way, at)}
      {:else if slot.kind === "unread"}
        {@render unreadCard(zone.id, zone.label, slot.state, at)}
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
</div>

<!-- Room to grow is a dashed outline, not a card: it is not a host yet. -->
{#snippet foundCard(machine: FoundMachine, at: Point)}
  <button
    type="button"
    onclick={() => onAdd("nearby")}
    onmouseenter={() => onPointFound(machine.key)}
    onmouseleave={() => onPointFound(null)}
    onfocus={() => onPointFound(machine.key)}
    onblur={() => onPointFound(null)}
    class="group absolute z-10 flex -translate-1/2 items-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-(--hairline-strongest) pr-3 pl-2 text-left text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-card motion-reduce:transition-none"
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

<!-- A zone whose hosts are not read yet: nothing is kept from an earlier start (plans/033 §3 Q2). -->
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

<style>
  /* The one continuous motion of the map, approved for it alone (docs/plans/host-fleet.md D5). */
  @keyframes travel {
    to {
      stroke-dashoffset: -160;
    }
  }
  @keyframes crawl {
    to {
      stroke-dashoffset: 18;
    }
  }
  .travel {
    stroke-dasharray: 18 142;
    animation: travel var(--travel, 6s) linear infinite;
  }
  .crawl {
    animation: crawl 4s linear infinite;
  }
  .paused .travel,
  .paused .crawl {
    animation-play-state: paused;
  }
  @media (prefers-reduced-motion: reduce) {
    .travel {
      display: none;
    }
    .crawl {
      animation: none;
    }
  }
</style>
