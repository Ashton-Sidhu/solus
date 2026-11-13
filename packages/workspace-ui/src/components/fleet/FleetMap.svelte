<script lang="ts">
  import { ChevronRight, Cloud, Laptop, Link2, Plus, Terminal } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import FleetMapCard from "./FleetMapCard.svelte";
  import FleetTile from "./FleetTile.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import type { FoundMachine } from "./lib/discover";
  import {
    cardPosition,
    groupsOf,
    HUB,
    isZoneFull,
    isZoneTroubled,
    linkPath,
    machineMatches,
    machinesByZone,
    rollup,
    toneOf,
    travelSeconds,
    TUNNEL,
    ZONES,
    type AddWay,
    type FleetMachine,
    type FleetZone,
    type FleetZoneId,
    type Point,
    type TileColorMode,
  } from "./lib/fleet-model";

  /**
   * The map (docs/plans/host-fleet.md D4): this device at the center, one zone for
   * each route, a link to each host, or one link for a zone too full for cards.
   * Its only continuous motion is the approved light on busy links (D5), paused
   * by `isLive`.
   */
  interface Props {
    machines: FleetMachine[];
    found: FoundMachine[];
    colorMode: TileColorMode;
    query: string;
    focusId: string | null;
    selectedId: string | null;
    isLive: boolean;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string) => void;
    onOpenZone: (zone: FleetZoneId) => void;
    onAdd: (way: AddWay) => void;
    onStart: (serverId: string) => void;
    onShowFound: () => void;
  }

  let { machines, found, colorMode, query, focusId, selectedId, isLive, onPoint, onSelect, onOpenZone, onAdd, onStart, onShowFound }: Props = $props();

  const byZone = $derived(machinesByZone(machines));
  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
  const tunneled = $derived([...byZone.cloud, ...byZone.shared]);
  const tunnelSummary = $derived(rollup(tunneled));
  const foundNearby = $derived(found.filter((machine) => machine.zone === "own"));
  const foundForwarded = $derived(found.filter((machine) => machine.zone === "forwarded"));

  const isFull = (zone: FleetZone) => isZoneFull(zone, byZone[zone.id].length);
  const isZoneLit = (zone: FleetZone) => !focusId || byZone[zone.id].some((machine) => machine.serverId === focusId);
  const isLit = (serverId: string) => !focusId || focusId === serverId;
  const startOf = (zone: FleetZone): Point => (zone.isViaTunnel ? TUNNEL : HUB);
  const along = (from: Point, to: Point, share: number) => ({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share });
  const zoneSubtitle = {
    own: "This network, Tailscale, or the tunnel",
    forwarded: "Forwarded by this device",
    cloud: "Through the tunnel",
    shared: "Shared with you",
  } satisfies Record<FleetZoneId, string>;
  const lineColor = (machine: FleetMachine) => {
    const tone = toneOf(machine.state);
    return tone === "ok" ? "color-mix(in oklch, var(--success) 80%, transparent)"
      : tone === "warn" ? "var(--warning)"
        : tone === "bad" ? "var(--solus-status-error)"
          : "var(--hairline-strong)";
  };
</script>

<div class="relative isolate h-[30rem] overflow-hidden bg-background bg-[radial-gradient(circle,var(--hairline)_1px,transparent_1px)] [background-size:18px_18px]" class:paused={!isLive}>
  <!-- Zones: one for each route. -->
  {#each ZONES as zone (zone.id)}
    {@const summary = rollup(byZone[zone.id])}
    <div
      class="absolute overflow-hidden rounded-xl border border-border/50 bg-background transition-opacity duration-300 motion-reduce:transition-none"
      style:left="{zone.x}%"
      style:top="{zone.y}%"
      style:width="{zone.w}%"
      style:height="{zone.h}%"
      style:opacity={isZoneLit(zone) ? 1 : 0.6}
    >
      <div class="relative flex items-start gap-2 px-3.5 pt-3">
        <div class="flex min-w-0 flex-1 flex-col">
          <p class="truncate text-chrome-dense font-medium whitespace-nowrap text-(--solus-text-secondary)">{zone.label}</p>
          {#if isFull(zone)}
            <p class="flex items-center gap-2.5">
              <HostStateIcon state="online" count={summary.answering} size={12} />
              {#if summary.reconnecting}<HostStateIcon state="reconnecting" count={summary.reconnecting} size={12} />{/if}
              {#if summary.unreachable}<HostStateIcon state="unreachable" count={summary.unreachable} size={12} />{/if}
              {#if summary.stopped}<HostStateIcon state="stopped" count={summary.stopped} size={12} />{/if}
            </p>
          {:else}
            <p class="truncate text-chrome-dense text-muted-foreground">{zoneSubtitle[zone.id]}</p>
          {/if}
        </div>
        {#if isFull(zone) && found.some((machine) => machine.zone === zone.id)}
          <button type="button" onclick={onShowFound} class="relative z-20 inline-flex h-[1.1875rem] shrink-0 items-center rounded-md bg-(--solus-status-running-bg) px-[7px] text-chrome-dense text-(--solus-status-running)">
            {found.filter((machine) => machine.zone === zone.id).length} found
          </button>
        {/if}
        {#if isFull(zone)}
          <button
            type="button"
            onclick={() => onOpenZone(zone.id)}
            aria-label="Open {zone.label}"
            class="relative z-20 -mt-1 -mr-1.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-(--wash-3) hover:text-foreground"
          >
            <ChevronRight size={13} />
          </button>
        {/if}
      </div>
    </div>
  {/each}

  <!-- Links: green when connected, the problem's color when not; a terracotta light moves along a link that carries sessions. -->
  <svg class="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    {#if tunneled.length}
      <g opacity={!focusId || tunneled.some((machine) => machine.serverId === focusId) ? 1 : 0.35}>
        <path d="M {HUB.x} {HUB.y} L {TUNNEL.x} {TUNNEL.y}" fill="none" stroke-width="1.75" vector-effect="non-scaling-stroke"
          style:stroke={tunnelSummary.answering ? "color-mix(in oklch, var(--success) 80%, transparent)" : "var(--hairline-strong)"} />
        {#if tunnelSummary.sessions}
          <path d="M {HUB.x} {HUB.y} L {TUNNEL.x} {TUNNEL.y}" fill="none" stroke-width="1.75" stroke-linecap="round" vector-effect="non-scaling-stroke"
            class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(tunnelSummary.sessions)}s" />
        {/if}
      </g>
    {/if}
    {#each ZONES as zone (zone.id)}
      {#if isFull(zone)}
        {@const summary = rollup(byZone[zone.id])}
        {@const width = 1.5 + Math.min(1.5, summary.sessions / 120)}
        <g opacity={isZoneLit(zone) ? 1 : 0.35}>
          <path d={linkPath(startOf(zone), zone.anchor)} fill="none" stroke-width={width} vector-effect="non-scaling-stroke"
            style:stroke={isZoneTroubled(summary) ? "var(--warning)" : "color-mix(in oklch, var(--success) 80%, transparent)"} />
          {#if summary.sessions}
            <path d={linkPath(startOf(zone), zone.anchor)} fill="none" stroke-width={width} stroke-linecap="round" vector-effect="non-scaling-stroke"
              class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(summary.sessions)}s" />
          {/if}
        </g>
      {:else}
        {#each byZone[zone.id] as machine, index (machine.serverId)}
          {@const tone = toneOf(machine.state)}
          {@const path = linkPath(startOf(zone), cardPosition(zone.id, index))}
          <g opacity={isLit(machine.serverId) ? 1 : 0.3}>
            <path d={path} fill="none" vector-effect="non-scaling-stroke"
              stroke-width={focusId === machine.serverId ? 2.25 : 1.5}
              stroke-dasharray={zone.id === "forwarded" ? "5 4" : tone === "ok" ? undefined : tone === "off" ? "3 4" : "2 4"}
              class:crawl={tone === "warn"}
              style:stroke={lineColor(machine)} />
            {#if tone === "ok" && machine.sessions}
              <path d={path} fill="none" stroke-width="1.5" stroke-linecap="round" vector-effect="non-scaling-stroke"
                class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(machine.sessions)}s" />
            {/if}
          </g>
        {/each}
      {/if}
    {/each}
  </svg>

  <!-- Link labels: latency, or the state icon of a host with a problem. Your own machines carry theirs on the card. -->
  {#each ZONES as zone (zone.id)}
    {#if isFull(zone)}
      {@const summary = rollup(byZone[zone.id])}
      {@const at = zone.id === "cloud" ? { x: 66.4, y: 27 } : along(startOf(zone), zone.anchor, zone.id === "shared" ? 0.45 : 0.5)}
      <span
        class="absolute z-15 inline-flex h-[1.1875rem] items-center gap-1.5 rounded-md border border-border/50 bg-background px-1.5 text-[0.6875rem] whitespace-nowrap text-(--solus-text-secondary) tabular-nums
          {zone.id === 'cloud' ? '-translate-x-full -translate-y-1/2' : '-translate-1/2'}"
        style:left="{at.x}%"
        style:top="{at.y}%"
        style:opacity={isZoneLit(zone) ? 1 : 0.35}
      >
        {summary.medianLatencyMs === null ? "—" : `${summary.medianLatencyMs} ms`}
        {#if summary.unreachable + summary.reconnecting}
          <HostStateIcon state="unreachable" count={summary.unreachable + summary.reconnecting} size={11} />
        {/if}
      </span>
    {:else if zone.id !== "own"}
      {#each byZone[zone.id] as machine, index (machine.serverId)}
        {@const at = along(startOf(zone), cardPosition(zone.id, index), zone.isViaTunnel ? 0.36 : 0.5)}
        {#if toneOf(machine.state) !== "off" && (toneOf(machine.state) !== "ok" || machine.latencyMs !== null)}
          <span
            class="absolute z-15 inline-flex h-[1.1875rem] -translate-1/2 items-center rounded-md border border-border/50 bg-background px-1.5 text-[0.6875rem] text-(--solus-text-secondary) tabular-nums"
            style:left="{at.x}%"
            style:top="{at.y}%"
            style:opacity={isLit(machine.serverId) ? 1 : 0.35}
          >
            {#if toneOf(machine.state) === "ok"}{machine.latencyMs} ms{:else}<HostStateIcon state={machine.state} size={11} />{/if}
          </span>
        {/if}
      {/each}
    {/if}
  {/each}

  {#if tunneled.length}
    <div class="absolute z-10 flex -translate-x-1/2 -translate-y-[11px] flex-col items-center gap-1" style:left="{TUNNEL.x}%" style:top="{TUNNEL.y}%">
      <span class="grid size-[22px] place-items-center rounded-full border border-(--success)/40 bg-background text-(--success)"><Link2 size={11} /></span>
      <span class="rounded-md bg-background px-1.5 text-[0.6875rem] whitespace-nowrap text-muted-foreground">Solus tunnel</span>
    </div>
  {/if}

  <!-- Full zones: one tile for each host, by organization or owner. -->
  {#each ZONES.filter(isFull) as zone (zone.id)}
    {@const groups = groupsOf(byZone[zone.id])}
    <div
      class="pointer-events-none absolute flex flex-col gap-2.5 overflow-hidden px-3.5 pt-[3.25rem] pb-3"
      style:left="{zone.x}%"
      style:top="{zone.y}%"
      style:width="{zone.w}%"
      style:height="{zone.h}%"
    >
      {#each groups as { group, machines: grouped } (group)}
        <div class="flex flex-col gap-1">
          {#if groups.length > 1}
            <p class="flex justify-between text-[0.6875rem] text-muted-foreground tabular-nums">
              <span class="truncate">{group ?? "Other"}</span><span>{rollup(grouped).answering} of {grouped.length}</span>
            </p>
          {/if}
          <div class="flex flex-wrap gap-[3px]">
            {#each grouped as machine (machine.serverId)}
              <FleetTile {machine} {colorMode} size={byZone[zone.id].length > 60 ? 8 : 11} {query} isFocused={focusId === machine.serverId} {onPoint} {onSelect} />
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/each}

  <!-- This device: the center. A web client has no host of its own, so its center is the browser. -->
  <div class="absolute z-20 w-[10.5rem] -translate-1/2" style:left="{HUB.x}%" style:top="{HUB.y}%">
    {#if device}
      <button
        type="button"
        onclick={() => onSelect(device.serverId)}
        onmouseenter={() => onPoint(device.serverId)}
        onmouseleave={() => onPoint(null)}
        onfocus={() => onPoint(device.serverId)}
        onblur={() => onPoint(null)}
        class="flex w-full items-center gap-2.5 rounded-xl border border-(--solus-status-running)/35 bg-background py-2.5 pr-3 pl-2.5 text-left shadow-[shadow:var(--solus-card-shadow-collapsed)] dark:shadow-none
          {selectedId === device.serverId ? 'outline-2 outline-offset-2 outline-(--solus-status-running)/60' : ''}"
      >
        <FleetLoadRing cpu={device.cpu} tone={toneOf(device.state)} size={34}><Laptop size={14} /></FleetLoadRing>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[0.8125rem] font-medium">{device.label}</span>
          <span class="flex items-center gap-1.5 text-chrome-dense text-(--solus-status-running)">
            This device
            {#if device.sessions}<HostStateIcon state="running" count={device.sessions} size={11} />{/if}
          </span>
        </span>
      </button>
    {:else}
      <div class="flex items-center gap-2.5 rounded-xl border border-(--solus-status-running)/35 bg-background py-2.5 pr-3 pl-2.5 shadow-[shadow:var(--solus-card-shadow-collapsed)] dark:shadow-none">
        <span class="grid size-[34px] shrink-0 place-items-center text-muted-foreground"><Laptop size={14} /></span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[0.8125rem] font-medium">This browser</span>
          <span class="text-chrome-dense text-(--solus-status-running)">This device</span>
        </span>
      </div>
    {/if}
  </div>

  <!-- Zones with room: a card for each host. -->
  {#each ZONES.filter((zone) => !isFull(zone)) as zone (zone.id)}
    {#each byZone[zone.id] as machine, index (machine.serverId)}
      <FleetMapCard
        {machine}
        at={cardPosition(zone.id, index)}
        isSelected={selectedId === machine.serverId}
        isDimmed={!machineMatches(machine, query)}
        showsLatency={zone.id === "own"}
        {onPoint}
        {onSelect}
        {onStart}
      />
    {/each}
  {/each}

  <!-- Room to grow: a found machine where it would go, else a way to add one. -->
  {#if byZone.own.length < 4}
    {#each foundNearby.slice(0, 4 - byZone.own.length) as machine, index (machine.key)}
      {@render foundCard(machine, cardPosition("own", byZone.own.length + index))}
    {/each}
  {/if}
  {#if byZone.forwarded.length === 0}
    {#if foundForwarded[0]}
      {@render foundCard(foundForwarded[0], cardPosition("forwarded", 0))}
    {:else}
      {@render ghostCard(cardPosition("forwarded", 0), "Add over SSH", "Any host you can reach", "ssh")}
    {/if}
  {/if}
  {#if byZone.cloud.length < 3}
    {@render ghostCard(cardPosition("cloud", byZone.cloud.length), "New machine", "Ready in a minute", "cloud")}
  {/if}
</div>

{#snippet foundCard(machine: FoundMachine, at: Point)}
  <button
    type="button"
    onclick={() => onAdd("nearby")}
    class="absolute z-10 flex w-[9.75rem] -translate-1/2 items-center gap-2.5 rounded-xl border border-dashed border-(--solus-status-running)/50 bg-background py-2 pr-3 pl-2 text-left hover:border-(--solus-status-running)/80"
    style:left="{at.x}%"
    style:top="{at.y}%"
  >
    <span class="grid size-[30px] shrink-0 place-items-center text-(--solus-status-running)">
      {#if machine.kind === "ssh"}<Terminal size={13} />{:else}<HostOperatingSystemIcon os={machine.os} size={13} />{/if}
    </span>
    <span class="flex min-w-0 flex-col gap-0.5">
      <span class="truncate text-[0.8125rem] font-medium">{machine.name}</span>
      <span class="truncate text-chrome-dense text-(--solus-status-running)">Found nearby</span>
    </span>
  </button>
{/snippet}

{#snippet ghostCard(at: Point, title: string, subtitle: string, way: AddWay)}
  <button
    type="button"
    onclick={() => onAdd(way)}
    class="absolute z-10 flex w-[9.75rem] -translate-1/2 items-center gap-2.5 rounded-xl border border-dashed border-border bg-background py-2 pr-3 pl-2 text-left text-muted-foreground hover:border-foreground/30 hover:text-foreground"
    style:left="{at.x}%"
    style:top="{at.y}%"
  >
    <span class="grid size-[30px] shrink-0 place-items-center">
      {#if way === "cloud"}<Plus size={13} />{:else if way === "ssh"}<Terminal size={13} />{:else}<Cloud size={13} />{/if}
    </span>
    <span class="flex min-w-0 flex-col gap-0.5">
      <span class="truncate text-[0.8125rem] font-medium">{title}</span>
      <span class="truncate text-chrome-dense">{subtitle}</span>
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
