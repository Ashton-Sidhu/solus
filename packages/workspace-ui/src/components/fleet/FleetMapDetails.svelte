<script lang="ts">
  import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Link2, X } from "@lucide/svelte";
  import { HOST_READINESS_ACTION_LABELS } from "@solus/client-core/host-readiness";
  import { reachedMachineDetail } from "@solus/client-core/reached-machines";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import HostStateIcon from "./HostStateIcon.svelte";
  import RouteKindIcon from "./RouteKindIcon.svelte";
  import { routeKindLabel } from "@solus/client-core/host-route-control";
  import type { FleetMachine } from "./lib/fleet-model";
  import { isTwoWay, REACH_HEALTH_LABELS, REACH_STYLES, reachHealthOf, reachNeedsAttention, type ReachEdge } from "./lib/fleet-reach";
  import { routeWireStyle, type WireRoute } from "./lib/fleet-routes";

  /** Below the map, what is selected on it, with what the person can do there:
   *  a host with each of its routes and the hosts it reaches; a line between two
   *  hosts with each way and its health; or the hosts picked for an introduction.
   *  Introduce to is the keyboard's way to do what a drag of a handle does. */
  interface Props {
    selected: FleetMachine | null;
    edge: ReachEdge | null;
    picked: FleetMachine[];
    /** The routes of the selected host, each with what it does now. */
    routes: WireRoute[];
    /** The lines that touch the selected host. */
    reaches: ReachEdge[];
    /** The hosts the selected host can be introduced to now. */
    candidates: FleetMachine[];
    canIntroduce: (serverId: string) => boolean;
    isOwner: (serverId: string) => boolean;
    labelOf: (serverId: string) => string;
    isBusy: boolean;
    onOpen: (serverId: string) => void;
    onFix: (machine: FleetMachine) => void;
    onSelect: (serverId: string) => void;
    onSelectEdge: (edgeId: string) => void;
    onIntroduce: (sourceId: string, targetIds: string[]) => void;
    onForget: (edge: ReachEdge) => void;
    onClear: () => void;
  }

  let { selected, edge, picked, routes, reaches, candidates, canIntroduce, isOwner, labelOf, isBusy, onOpen, onFix, onSelect, onSelectEdge, onIntroduce, onForget, onClear }: Props = $props();

  const otherEnd = (line: ReachEdge, serverId: string) => (line.a === serverId ? line.b : line.a);
  /** How the selected host and the other end reach each other, from the selected host's side. */
  const directionOf = (line: ReachEdge, serverId: string) => {
    if (isTwoWay(line)) return "both";
    const outward = line.a === serverId ? line.forward : line.back;
    return outward ? "out" : "in";
  };
  const isIntroduced = (line: ReachEdge) => line.forward?.way === "introduced" || line.back?.way === "introduced";
  const canForget = (line: ReachEdge) => isIntroduced(line) && (isOwner(line.a) || isOwner(line.b));
  const pickedTargets = $derived(selected ? picked.filter((machine) => machine.serverId !== selected.serverId && canIntroduce(machine.serverId)) : []);
</script>

<div class="flex flex-col gap-3 border-t border-border/40 px-4 py-3.5" aria-live="polite">
  {#if edge}
    {@const style = REACH_STYLES[edge.health]}
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="flex min-w-0 items-center gap-2 text-workspace-chrome font-medium">
          <button type="button" class="truncate hover:underline" onclick={() => onSelect(edge.a)}>{labelOf(edge.a)}</button>
          {#if isTwoWay(edge)}<ArrowLeftRight size={14} aria-label="and" class="shrink-0" />{:else if edge.forward}<ArrowRight size={14} aria-label="reaches" class="shrink-0" />{:else}<ArrowLeft size={14} aria-label="is reached by" class="shrink-0" />{/if}
          <button type="button" class="truncate hover:underline" onclick={() => onSelect(edge.b)}>{labelOf(edge.b)}</button>
        </p>
        <p class="flex items-center gap-1.5 text-chrome-dense text-muted-foreground">
          <svg aria-hidden="true" viewBox="0 0 18 4" class="h-1 w-4.5"><path d="M0 2H18" stroke-width="2" stroke-dasharray={style.dash ?? undefined} style:stroke={style.color} /></svg>
          {REACH_HEALTH_LABELS[edge.health]}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if !isTwoWay(edge) && canIntroduce(edge.a) && canIntroduce(edge.b)}
          <Button variant="outline" size="sm" disabled={isBusy} onclick={() => onIntroduce(edge.a, [edge.b])}><ArrowLeftRight size={13} />Both ways</Button>
        {/if}
        {#if canForget(edge)}
          <Button variant="ghost" size="sm" disabled={isBusy} onclick={() => onForget(edge)}>Forget</Button>
        {/if}
        <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onclick={onClear}><X size={14} /></Button>
      </div>
    </div>
    <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-chrome-dense">
      {#each [[edge.a, edge.b, edge.forward], [edge.b, edge.a, edge.back]] as const as [from, to, way] (from)}
        <dt class="text-muted-foreground">{labelOf(from)} → {labelOf(to)}</dt>
        <dd class="min-w-0 truncate {way && reachNeedsAttention(reachHealthOf(way)) ? 'text-(--solus-status-error)' : ''}">
          {#if way}
            {reachedMachineDetail(way)}{#if way.health?.kind === "failing" || (way.health?.kind === "expired" && way.health.detail)}: {way.health.detail}{/if}
          {:else}
            <span class="text-muted-foreground">Does not reach it</span>
          {/if}
        </dd>
      {/each}
    </dl>
    {#if canForget(edge)}
      <p class="text-chrome-dense text-pretty text-muted-foreground">Forget stops the introduction on both hosts. They stay forgotten until you introduce them again.</p>
    {/if}
  {:else if selected}
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="flex min-w-0 items-center gap-2">
          <span class="truncate text-workspace-chrome font-medium">{selected.label}</span>
          <HostStateIcon state={selected.state} label={selected.problem?.label} count={selected.state === "running" ? selected.sessions : undefined} />
          {#if selected.needsSetup}<HostStateIcon state="signin" />{/if}
          {#if selected.hasUpdate}<HostStateIcon state="update" />{/if}
        </p>
        <p class="truncate text-chrome-dense text-muted-foreground tabular-nums">
          {#if selected.problem}{selected.problem.headline}{#if selected.problem.detail}. {selected.problem.detail}{/if}
          {:else}{#if selected.cpu !== null}CPU {selected.cpu}%{/if}{#if selected.memory !== null} · memory {selected.memory}%{/if}{#if selected.latencyMs !== null} · {selected.latencyMs} ms{/if}{/if}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if selected.problem?.action}
          <Button variant="outline" size="sm" onclick={() => onFix(selected)}>{HOST_READINESS_ACTION_LABELS[selected.problem.action]}</Button>
        {/if}
        {#if canIntroduce(selected.serverId) && (candidates.length || pickedTargets.length)}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="outline" size="sm" disabled={isBusy}><Link2 size={13} />Introduce to</Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="min-w-48">
              {#if pickedTargets.length}
                <DropdownMenu.Item onSelect={() => onIntroduce(selected.serverId, pickedTargets.map((machine) => machine.serverId))}>
                  The {pickedTargets.length} picked {pickedTargets.length === 1 ? "host" : "hosts"}
                </DropdownMenu.Item>
                {#if candidates.length}<DropdownMenu.Separator />{/if}
              {/if}
              {#each candidates as candidate (candidate.serverId)}
                <DropdownMenu.Item onSelect={() => onIntroduce(selected.serverId, [candidate.serverId])}>{candidate.label}</DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
        <Button variant="outline" size="sm" onclick={() => onOpen(selected.serverId)}><ArrowUpRight size={13} />Open</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onclick={onClear}><X size={14} /></Button>
      </div>
    </div>
    <div class="grid gap-x-8 gap-y-3 @min-[40rem]/fleet:grid-cols-2">
      {#if !selected.isThisDevice}
        <section class="flex min-w-0 flex-col gap-1">
          <h3 class="text-chrome-dense font-medium text-(--solus-text-secondary)">Routes from this device</h3>
          {#each routes as route (route.url)}
            {@const style = routeWireStyle(route.state)}
            <p class="flex min-w-0 items-center gap-2 text-chrome-dense">
              <span class="grid size-4 shrink-0 place-items-center rounded-full border {style.markBorder === 'dashed' ? 'border-dashed' : style.markBorder === 'dotted' ? 'border-dotted' : ''} {style.badge === 'refused' ? 'border-(--solus-status-error)/60 text-(--solus-status-error)' : 'border-border text-muted-foreground'}"><RouteKindIcon kind={route.kind} size={9} /></span>
              <span class="shrink-0">{routeKindLabel(route.kind)}</span>
              <span class="min-w-0 truncate font-mono text-muted-foreground">{route.url}</span>
              {#if route.stateText}<span class="ml-auto shrink-0 {route.state === 'in-use' ? 'font-medium' : 'text-muted-foreground'}">{route.stateText}</span>{/if}
            </p>
          {:else}
            <p class="text-chrome-dense text-muted-foreground">This device has no saved route to it.</p>
          {/each}
        </section>
      {/if}
      <section class="flex min-w-0 flex-col gap-1">
        <h3 class="text-chrome-dense font-medium text-(--solus-text-secondary)">Hosts it reaches</h3>
        {#each reaches as line (line.id)}
          {@const other = otherEnd(line, selected.serverId)}
          {@const direction = directionOf(line, selected.serverId)}
          {@const style = REACH_STYLES[line.health]}
          <button type="button" onclick={() => onSelectEdge(line.id)} class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md text-left text-chrome-dense hover:bg-(--wash-1)">
            {#if direction === "both"}<ArrowLeftRight size={13} aria-label="Both ways" class="shrink-0" />{:else if direction === "out"}<ArrowRight size={13} aria-label="Reaches" class="shrink-0" />{:else}<ArrowLeft size={13} aria-label="Reached by" class="shrink-0" />{/if}
            <span class="min-w-0 truncate">{labelOf(other)}</span>
            <svg aria-hidden="true" viewBox="0 0 18 4" class="ml-auto h-1 w-4.5 shrink-0"><path d="M0 2H18" stroke-width="2" stroke-dasharray={style.dash ?? undefined} style:stroke={style.color} /></svg>
            <span class="shrink-0 {reachNeedsAttention(line.health) ? 'text-(--solus-status-error)' : 'text-muted-foreground'}">{REACH_HEALTH_LABELS[line.health]}</span>
          </button>
        {:else}
          <p class="text-chrome-dense text-pretty text-muted-foreground">
            {canIntroduce(selected.serverId) ? "No other host on the map. Drag its + onto a host to introduce them." : "This device cannot read which hosts it reaches."}
          </p>
        {/each}
      </section>
    </div>
  {:else if picked.length}
    <div class="flex items-center justify-between gap-4">
      <p class="min-w-0 text-chrome-dense text-pretty">
        <span class="font-medium">{picked.length} {picked.length === 1 ? "host" : "hosts"} picked:</span>
        <span class="text-muted-foreground">{picked.map((machine) => machine.label).join(", ")}.</span>
        <span class="text-muted-foreground">Drag a host's + onto one of them to introduce it to all, or select a host and use Introduce to.</span>
      </p>
      <Button variant="ghost" size="sm" onclick={onClear}>Clear</Button>
    </div>
  {/if}
</div>
