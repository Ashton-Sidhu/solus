<script lang="ts">
  import { Ban, Link2, X } from "@lucide/svelte";
  import * as Tooltip from "../ui/tooltip";
  import RouteKindIcon from "./RouteKindIcon.svelte";
  import { linkPath, rollup, toneOf, trafficOf, trafficText, trafficWidth, travelSeconds, type FleetMachine, type FleetTone, type MapLayout } from "./lib/fleet-model";
  import { routeWireLabel, routeWireStyle, type FannedRoutes, type WireRoute } from "./lib/fleet-routes";

  /** How this device reaches each host. A host with a card has a wire for each of
   *  its routes, in the order it tries them: the one in use solid and as wide as
   *  its traffic, the others quiet, and each kind of trouble with its own dash and
   *  a mark at the card. A full zone has one line, and so does the tunnel. A light
   *  moves along a line that carries sessions; it is the map's one continuous
   *  motion, paused when the map is not seen, and gone with reduced motion. */
  interface Props {
    map: MapLayout;
    /** The wires of each host with a card, by server id. A host with no saved route has none. */
    wires: ReadonlyMap<string, FannedRoutes>;
    isLit: (serverId: string) => boolean;
    focusId: string | null;
  }

  let { map, wires, isLit, focusId }: Props = $props();

  const tunneled = $derived(map.zones.flatMap(({ zone, hosts }) => (zone.isViaTunnel ? hosts : [])));
  const hubPort = $derived({ x: map.hub.x + map.hub.w / 2, y: map.hub.y });
  const tunnelSummary = $derived(rollup(tunneled));
  const tunnelWidth = $derived(trafficWidth(trafficOf(tunneled)));
  const isGroupLit = (hosts: FleetMachine[]) => !focusId || hosts.some((machine) => isLit(machine.serverId));
  const okLine = "color-mix(in oklch, var(--success) 80%, transparent)";
  const portColor = {
    ok: "var(--success)",
    warn: "var(--warning)",
    bad: "var(--solus-status-error)",
    off: "var(--solus-status-idle)",
  } satisfies Record<FleetTone, string>;
  /** A host with no saved route still has one line, drawn from its state: each tone with its own dash. */
  const toneDash = { ok: undefined, warn: "1 4", bad: "6 3", off: "2 6" } satisfies Record<FleetTone, string | undefined>;
  const markLabel = (route: WireRoute, machine: FleetMachine, hidden: WireRoute[], isLast: boolean) => {
    const traffic = route.state === "in-use" ? trafficText(machine.traffic) : null;
    const more = isLast && hidden.length ? `\nAlso: ${hidden.map(routeWireLabel).join("; ")}` : "";
    return `${routeWireLabel(route)}${traffic ? ` · ${traffic}` : ""}${more}`;
  };
</script>

<svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
  {#if tunneled.length}
    <g opacity={isGroupLit(tunneled) ? 1 : 0.35}>
      <path d={linkPath(hubPort, map.tunnel)} fill="none" stroke-width={tunnelWidth} vector-effect="non-scaling-stroke"
        style:stroke={tunnelSummary.answering ? okLine : "var(--hairline-strong)"} stroke-dasharray={tunnelSummary.answering ? undefined : "2 6"} />
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
      <g opacity={isGroupLit(hosts) ? 1 : 0.35}>
        <path d={path} fill="none" stroke-width={width} vector-effect="non-scaling-stroke"
          stroke-dasharray={summary.answering ? undefined : "2 6"}
          style:stroke={summary.answering ? okLine : "var(--hairline-strong)"} />
        {#if summary.sessions}
          <path d={path} fill="none" stroke-width={width} stroke-linecap="round" vector-effect="non-scaling-stroke"
            class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(summary.sessions)}s" />
        {/if}
      </g>
    {:else}
      {#each rows as row (row.slot.kind === "host" ? row.slot.machine.serverId : `${row.slot.kind}:${row.at.y}`)}
        {#if row.slot.kind === "host"}
          {@const machine = row.slot.machine}
          {@const fanned = wires.get(machine.serverId)}
          {@const lit = isLit(machine.serverId)}
          {@const extra = focusId === machine.serverId ? 0.75 : 0}
          <g opacity={lit ? 1 : 0.3}>
            {#if fanned?.wires.length}
              <!-- Quiet wires first, so the route in use lies over them. -->
              {#each [...fanned.wires].sort((left, right) => Number(left.route.state === "in-use") - Number(right.route.state === "in-use")) as wire (wire.route.url)}
                {@const style = routeWireStyle(wire.route.state)}
                {@const width = (style.width ?? trafficWidth(trafficOf([machine]))) + extra}
                <path d={linkPath(wire.from, wire.to)} fill="none" vector-effect="non-scaling-stroke" stroke-width={width}
                  stroke-dasharray={style.dash ?? undefined} class:crawl={style.crawls} style:stroke={style.color} />
                {#if wire.route.state === "in-use" && machine.sessions}
                  <path d={linkPath(wire.from, wire.to)} fill="none" stroke-width={width} stroke-linecap="round" vector-effect="non-scaling-stroke"
                    class="travel" style:stroke="var(--solus-status-running)" style:--travel="{travelSeconds(machine.sessions)}s" />
                {/if}
              {/each}
            {:else}
              {@const tone = toneOf(machine.state)}
              <path d={linkPath(linkStart, row.port)} fill="none" vector-effect="non-scaling-stroke"
                stroke-width={trafficWidth(trafficOf([machine])) + extra}
                stroke-dasharray={toneDash[tone]} class:crawl={tone === "warn"}
                style:stroke={tone === "ok" ? okLine : tone === "off" ? "var(--hairline-strong)" : portColor[tone]} />
            {/if}
          </g>
        {/if}
      {/each}
    {/if}
  {/each}
</svg>

<!-- Ports: where a line meets its card, or the edge of a full zone. Their shape repeats the state: round when it answers, a ring while it reconnects, a diamond when it does not answer. -->
{#each map.zones as { zone, hosts, isFull, rows, port } (zone.id)}
  {#if isFull}
    <span
      aria-hidden="true"
      class="absolute z-15 size-[5px] -translate-1/2 rounded-full ring-[1.5px] ring-background"
      style:left="{port.x}%"
      style:top="{port.y}%"
      style:background={rollup(hosts).answering ? portColor.ok : portColor.off}
      style:opacity={isGroupLit(hosts) ? 1 : 0.35}
    ></span>
  {:else}
    {#each rows as row (row.slot.kind === "host" ? row.slot.machine.serverId : `${row.slot.kind}:${row.at.y}`)}
      {#if row.slot.kind === "host"}
        {@const tone = toneOf(row.slot.machine.state)}
        <span
          aria-hidden="true"
          class="absolute z-15 -translate-1/2 ring-[1.5px] ring-background forced-colors:bg-[CanvasText]
            {tone === 'bad' ? 'size-[6px] rotate-45 rounded-[1px]' : tone === 'warn' ? 'size-[7px] rounded-full border-[1.5px] bg-background!' : 'size-[5px] rounded-full'}"
          style:left="{row.port.x}%"
          style:top="{row.port.y}%"
          style:background={portColor[tone]}
          style:border-color={portColor[tone]}
          style:opacity={isLit(row.slot.machine.serverId) ? 1 : 0.3}
        ></span>
      {/if}
    {/each}
  {/if}
{/each}

<!-- A mark for each route, on its wire near the card: its kind as an icon, its state in the border and a sign, and the words in its tooltip. -->
{#each map.zones as { zone, rows } (zone.id)}
  {#each rows as row (row.slot.kind === "host" ? row.slot.machine.serverId : `${row.slot.kind}:${row.at.y}`)}
    {#if row.slot.kind === "host"}
      {@const machine = row.slot.machine}
      {@const fanned = wires.get(machine.serverId)}
      {#each fanned?.wires ?? [] as wire, index (wire.route.url)}
        {@const style = routeWireStyle(wire.route.state)}
        {@const label = markLabel(wire.route, machine, fanned?.hidden ?? [], index === (fanned?.wires.length ?? 0) - 1)}
        {#if wire.route.kind !== "tunnel"}
          <Tooltip.Root delayDuration={150}>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <span
                  {...props}
                  role="img"
                  aria-label={label}
                  class="absolute z-15 grid size-[16px] -translate-1/2 place-items-center rounded-full border bg-card transition-opacity duration-300 motion-reduce:transition-none forced-colors:border-[CanvasText]
                    {style.markBorder === 'dashed' ? 'border-dashed' : style.markBorder === 'dotted' ? 'border-dotted' : ''}
                    {wire.route.state === 'in-use' ? 'border-(--success)/60 text-foreground' : style.badge === 'refused' ? 'border-(--solus-status-error)/60 text-(--solus-status-error)' : wire.route.state === 'connecting' ? 'border-(--warning)/60 text-(--warning)' : 'border-border/70 text-muted-foreground'}"
                  style:left="{wire.mark.x}%"
                  style:top="{wire.mark.y}%"
                  style:opacity={isLit(machine.serverId) ? 1 : 0.3}
                >
                  <RouteKindIcon kind={wire.route.kind} size={9} />
                  {#if style.badge}
                    <span aria-hidden="true" class="absolute -top-1 -right-1 grid size-[9px] place-items-center rounded-full bg-card {style.badge === 'refused' ? 'text-(--solus-status-error)' : 'text-muted-foreground'}">
                      {#if style.badge === "refused"}<X size={8} strokeWidth={3} />{:else}<Ban size={8} strokeWidth={2.5} />{/if}
                    </span>
                  {/if}
                </span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content value={label} />
          </Tooltip.Root>
        {/if}
      {/each}
    {/if}
  {/each}
{/each}

{#if tunneled.length}
  <span
    role="img"
    aria-label="Solus tunnel"
    title="Solus tunnel"
    class="absolute z-10 grid size-[22px] -translate-1/2 place-items-center rounded-full border bg-card
      {tunnelSummary.answering ? 'border-(--success)/40 text-(--success)' : 'border-dashed border-border text-muted-foreground'}"
    style:left="{map.tunnel.x}%"
    style:top="{map.tunnel.y}%"
  >
    <Link2 size={11} />
  </span>
{/if}

<style>
  /* The one continuous motion of the map: a light along a line that carries sessions, and the crawl of a route being tried. */
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
  :global(.paused) .travel,
  :global(.paused) .crawl {
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
