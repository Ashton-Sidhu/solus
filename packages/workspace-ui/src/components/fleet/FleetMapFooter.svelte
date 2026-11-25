<script lang="ts">
  import { Link2 } from "@lucide/svelte";
  import { HOST_READINESS_ACTION_LABELS } from "@solus/client-core/host-readiness";
  import { routeKindLabel, type RouteState } from "@solus/client-core/host-route-control";
  import type { RouteKind } from "@solus/contracts/host-routes";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import type { FoundMachine } from "./lib/discover";
  import { routeHops, type FleetMachine, type TileColorMode } from "./lib/fleet-model";

  /** Below the map, at one height, so pointing at a host never moves the page:
   *  the host under the pointer and its route, the found machine under it and
   *  how to add it (D7), or the legend. The height fits the host and its route,
   *  and a legend that wraps to two lines; the legend sits in its middle, so the
   *  spare room is even above and below it. For a host it also gives why it does
   *  not answer and the one fix, and every other route with what it does now. */
  interface Props {
    machine: FleetMachine | null;
    found: FoundMachine | null;
    colorMode: TileColorMode;
    /** The routes of `machine`, each with its state. */
    routes: Array<{ url: string; kind: RouteKind; state: RouteState | null; stateText: string | null }>;
    /** Does the one action of the host's problem: retry, start, or pair again. */
    onFix: (machine: FleetMachine) => void;
  }

  let { machine, found, colorMode, routes, onFix }: Props = $props();
  /** The route in use is in the hops; the others follow it with their state. */
  const otherRoutes = $derived(routes.filter((route) => route.state !== "in-use" && route.stateText));

  const hops = $derived(machine ? routeHops(machine) : []);
  const howToAdd = {
    server: "It runs Solus. Click it, then enter the code it shows.",
    wsl: "A WSL distro. Click it, and Solus installs itself there.",
    ssh: "A machine in your SSH config. Click it to add it over SSH.",
  } satisfies Record<FoundMachine["kind"], string>;
</script>

<div class="flex h-24 flex-col gap-2.5 border-t border-border/40 px-4 py-3.5 {machine || found ? 'justify-between' : 'justify-center'}" aria-live="polite">
  {#if machine}
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="flex min-w-0 items-center gap-2">
          <span class="truncate text-workspace-chrome font-medium">{machine.label}</span>
          <HostStateIcon state={machine.state} label={machine.problem?.label} count={machine.state === "running" ? machine.sessions : undefined} />
          {#if machine.needsSetup}<HostStateIcon state="signin" />{/if}
          {#if machine.hasUpdate}<HostStateIcon state="update" />{/if}
        </p>
        <p class="truncate text-chrome-dense text-muted-foreground tabular-nums">
          {#if machine.problem}{machine.problem.headline}{#if machine.problem.detail}. {machine.problem.detail}{/if}
          {:else}{#if machine.cpu !== null}CPU {machine.cpu}%{/if}{#if machine.memory !== null} · memory {machine.memory}%{/if}{#if machine.latencyMs !== null} · {machine.latencyMs} ms{/if}{/if}
        </p>
      </div>
      {#if machine.problem?.action}
        <Button variant="outline" size="sm" class="shrink-0" onclick={() => onFix(machine)}>{HOST_READINESS_ACTION_LABELS[machine.problem.action]}</Button>
      {/if}
    </div>
    <div class="flex min-w-0 items-center gap-4 overflow-hidden font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground">
      <ol class="flex min-w-0 shrink items-center overflow-hidden">
        {#each hops as hop, index (index)}
          <li class="flex min-w-0 items-center">
            {#if index > 0}<span aria-hidden="true" class="mx-2 h-px w-5 shrink-0 bg-(--success)/60"></span>{/if}
            <span class="truncate {index === hops.length - 1 ? 'text-foreground' : ''}">{hop}</span>
          </li>
        {/each}
      </ol>
      {#if otherRoutes.length}
        <p class="min-w-0 truncate font-sans text-chrome-dense" title={otherRoutes.map((route) => `${routeKindLabel(route.kind)} ${route.url}: ${route.stateText}`).join("\n")}>
          {#each otherRoutes as route, index (route.url)}{index ? " · " : ""}{routeKindLabel(route.kind)}: <span class={route.state === "refused" || route.state === "different-server" ? "text-(--solus-status-error)" : route.state === "connecting" || route.state === "not-answering" ? "text-(--warning)" : ""}>{route.stateText}</span>{/each}
        </p>
      {/if}
    </div>
  {:else if found}
    <div class="flex min-w-0 flex-col gap-0.5">
      <p class="truncate text-workspace-chrome font-medium">{found.name}</p>
      <p class="truncate font-mono text-chrome-dense text-muted-foreground">{found.detail}</p>
    </div>
    <p class="truncate text-chrome-dense text-muted-foreground">{howToAdd[found.kind]}</p>
  {:else}
    <p class="text-[0.8125rem] text-(--solus-text-secondary)">Point at a host to see how this device reaches it. Click it to open it.</p>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-chrome-dense text-muted-foreground">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4 rounded-full bg-(--success)/80"></span>Connected</span>
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4 rounded-full bg-(--solus-status-running)"></span>Sessions moving</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dotted border-(--warning)"></span>Reconnecting</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dotted border-(--solus-status-error)"></span>Unreachable</span>
      <span class="flex items-center gap-1.5"><Link2 size={12} class="text-(--success)" />Solus tunnel</span>
      <span class="flex items-center gap-1.5"><span class="h-px w-2.5 bg-(--success)"></span><span class="h-1 w-2.5 rounded-full bg-(--success)"></span>Thicker: more traffic</span>
      {#if colorMode === "status"}
        <span class="flex items-center gap-1.5"><span class="size-2 rounded-[2px] bg-(--success)/80"></span>Idle<span class="ml-1.5 size-2 rounded-[2px] bg-(--solus-status-running)/60"></span>Running</span>
      {:else if colorMode === "cpu"}
        <span class="flex items-center gap-1.5">CPU<span class="h-2 w-14 rounded-[2px] bg-linear-to-r from-(--success)/40 via-(--warning) to-(--solus-status-error)"></span></span>
      {:else}
        <span class="flex items-center gap-1.5">Sessions<span class="h-2 w-14 rounded-[2px] bg-linear-to-r from-(--wash-3) to-(--solus-status-running)"></span></span>
      {/if}
    </div>
  {/if}
</div>
