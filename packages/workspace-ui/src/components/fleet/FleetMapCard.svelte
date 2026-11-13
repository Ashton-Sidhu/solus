<script lang="ts">
  import { Power } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { toneOf, type FleetMachine, type Point } from "./lib/fleet-model";

  /** One host as a card on the map: its OS logo in a CPU ring, its name, and its
   *  state as an icon. A card on the local network side carries its latency, since
   *  its link is too short for a label. */
  interface Props {
    machine: FleetMachine;
    at: Point;
    isSelected: boolean;
    isDimmed: boolean;
    showsLatency: boolean;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string) => void;
    onStart: (serverId: string) => void;
  }

  let { machine, at, isSelected, isDimmed, showsLatency, onPoint, onSelect, onStart }: Props = $props();

  const tone = $derived(toneOf(machine.state));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  class="absolute z-10 flex w-[9.75rem] -translate-1/2 items-center gap-2.5 rounded-xl border bg-background py-2 pr-3 pl-2 shadow-[shadow:var(--solus-card-shadow-collapsed)] transition-opacity duration-300 motion-reduce:transition-none dark:shadow-none
    {tone === 'bad' ? 'border-(--solus-status-error)/45' : tone === 'warn' ? 'border-(--warning)/45' : 'border-border/60'}
    {isSelected ? 'outline-2 outline-offset-2 outline-(--solus-status-running)/60' : ''}"
  style:left="{at.x}%"
  style:top="{at.y}%"
  style:opacity={isDimmed ? 0.35 : tone === "off" ? 0.75 : 1}
>
  {#if machine.hasUpdate}
    <span class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-(--solus-status-running)" title="Update available"></span>
  {/if}
  <FleetLoadRing cpu={machine.cpu} {tone}>
    <HostOperatingSystemIcon os={machine.os} managed={machine.isManaged} size={13} />
  </FleetLoadRing>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <button
      type="button"
      onclick={() => onSelect(machine.serverId)}
      onfocus={() => onPoint(machine.serverId)}
      onblur={() => onPoint(null)}
      class="truncate text-left text-[0.8125rem] font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
    >
      {machine.label}
    </button>
    <div class="flex min-w-0 items-center gap-1.5">
      {#if machine.state === "stopped" && machine.isManaged}
        <button
          type="button"
          onclick={() => onStart(machine.serverId)}
          class="relative z-10 inline-flex items-center gap-1 text-chrome-dense text-(--solus-text-secondary) hover:text-foreground"
        >
          <Power size={11} />Start
        </button>
      {:else}
        <HostStateIcon state={machine.state} count={machine.state === "running" ? machine.sessions : undefined} />
      {/if}
      {#if machine.needsSetup}<HostStateIcon state="signin" />{/if}
      {#if showsLatency && machine.latencyMs !== null}
        <span class="ml-auto shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums">{machine.latencyMs} ms</span>
      {/if}
    </div>
  </div>
</div>
