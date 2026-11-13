<script lang="ts">
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { routeHops, type FleetMachine, type TileColorMode } from "./lib/fleet-model";

  /** Below the map, at one height, so pointing at a host never moves the page:
   *  the host under the pointer and its route, or the legend. */
  interface Props {
    machine: FleetMachine | null;
    colorMode: TileColorMode;
    onOpen: (serverId: string) => void;
  }

  let { machine, colorMode, onOpen }: Props = $props();

  const hops = $derived(machine ? routeHops(machine) : []);
</script>

<div class="flex h-[6.75rem] flex-col justify-between gap-2 border-t border-border/40 px-4 py-3.5" aria-live="polite">
  {#if machine}
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="flex min-w-0 items-center gap-2">
          <span class="truncate text-workspace-chrome font-medium">{machine.label}</span>
          <HostStateIcon state={machine.state} count={machine.state === "running" ? machine.sessions : undefined} />
          {#if machine.needsSetup}<HostStateIcon state="signin" />{/if}
          {#if machine.hasUpdate}<HostStateIcon state="update" />{/if}
        </p>
        <p class="truncate text-chrome-dense text-muted-foreground tabular-nums">
          {#if machine.cpu !== null}CPU {machine.cpu}%{/if}{#if machine.memory !== null} · memory {machine.memory}%{/if}{#if machine.latencyMs !== null} · {machine.latencyMs} ms{/if}
        </p>
      </div>
      <Button variant="outline" size="sm" class="shrink-0" onclick={() => onOpen(machine.serverId)}>Open</Button>
    </div>
    <ol class="flex min-w-0 items-center overflow-hidden font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground">
      {#each hops as hop, index (index)}
        <li class="flex min-w-0 items-center">
          {#if index > 0}<span aria-hidden="true" class="mx-2 h-px w-5 shrink-0 bg-(--success)/60"></span>{/if}
          <span class="truncate {index === hops.length - 1 ? 'text-foreground' : ''}">{hop}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="text-[0.8125rem] text-(--solus-text-secondary)">Point at a host to see how this device reaches it.</p>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-chrome-dense text-muted-foreground">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4 rounded-full bg-(--success)/80"></span>Connected</span>
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4 rounded-full bg-(--solus-status-running)"></span>Sessions moving</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dotted border-(--warning)"></span>Reconnecting</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dotted border-(--solus-status-error)"></span>Unreachable</span>
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
