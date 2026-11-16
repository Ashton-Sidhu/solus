<script lang="ts">
  import { Power } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { CARD_HEIGHT, toneOf, type FleetMachine, type Point } from "./lib/fleet-model";

  /** One host as a card on the map: its OS logo in a CPU ring, its name, its
   *  state as an icon, and its latency. `at` is the card's center and `width` its
   *  width, both in percent of the map. `data-host-id` names the host to the
   *  map's context menu (D12). */
  interface Props {
    machine: FleetMachine;
    at: Point;
    width: number;
    isDimmed: boolean;
    onPoint: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
    onStart: (serverId: string) => void;
  }

  let { machine, at, width, isDimmed, onPoint, onOpen, onStart }: Props = $props();

  const tone = $derived(toneOf(machine.state));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-host-id={machine.serverId}
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  class="absolute z-10 flex -translate-1/2 items-center gap-2.5 rounded-xl border bg-card pr-3 pl-2 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08),0_2px_6px_-2px_rgb(0_0_0/0.06)] transition-opacity duration-300 motion-reduce:transition-none dark:shadow-none
    {tone === 'bad' ? 'border-(--solus-status-error)/35' : tone === 'warn' ? 'border-(--warning)/40' : 'border-border/60'}
    hover:border-foreground/25"
  style:left="{at.x}%"
  style:top="{at.y}%"
  style:width="{width}%"
  style:height="{CARD_HEIGHT}rem"
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
      onclick={() => onOpen(machine.serverId)}
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
      {#if machine.latencyMs !== null}
        <span class="ml-auto shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums">{machine.latencyMs} ms</span>
      {/if}
    </div>
  </div>
</div>
