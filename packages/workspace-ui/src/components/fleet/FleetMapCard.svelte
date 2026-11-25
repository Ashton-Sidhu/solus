<script lang="ts">
  import { Plus, Power } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import FleetLoadRing from "./FleetLoadRing.svelte";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { CARD_HEIGHT, toneOf, type FleetMachine, type Point } from "./lib/fleet-model";

  /** One host as a card on the map: its OS logo in a CPU ring, its name, its
   *  state as an icon, and its latency. `at` is the card's center and `width` its
   *  width, both in percent of the map. `data-host-id` names the host to the
   *  map's context menu, its keys, and a drop. A click selects it, a click on the
   *  selected card opens it, and Shift-click adds it to the hosts picked for an
   *  introduction. The
   *  outline repeats its state without color: dashed when it does not answer,
   *  dotted while it reconnects. The handle beside a host of yours drags onto
   *  another host to introduce the two. */
  interface Props {
    machine: FleetMachine;
    at: Point;
    width: number;
    /** Find names other hosts. */
    isDimmed: boolean;
    /** Another host is selected or pointed at, and this one is not next to it. */
    isFaded: boolean;
    isSelected: boolean;
    isPicked: boolean;
    /** The one host of the map that Tab reaches. */
    isCurrent: boolean;
    /** A host of yours that this device can introduce: it shows the handle. */
    canIntroduce: boolean;
    /** While a handle is dragged over it: whether the drop would introduce. */
    dropState: "ok" | "no" | null;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string, isAdding: boolean) => void;
    onStart: (serverId: string) => void;
    onHandleDown: (event: PointerEvent, serverId: string) => void;
  }

  let { machine, at, width, isDimmed, isFaded, isSelected, isPicked, isCurrent, canIntroduce, dropState, onPoint, onSelect, onStart, onHandleDown }: Props = $props();

  const tone = $derived(toneOf(machine.state));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-host-id={machine.serverId}
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  class="group absolute z-10 flex -translate-1/2 items-center gap-2.5 rounded-xl border bg-card pr-3 pl-2 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08),0_2px_6px_-2px_rgb(0_0_0/0.06)] transition-opacity duration-300 motion-reduce:transition-none dark:shadow-none forced-colors:border-[CanvasText]
    {tone === 'bad' ? 'border-dashed border-(--solus-status-error)/55' : tone === 'warn' ? 'border-dotted border-(--warning)/60' : 'border-border/60'}
    {isSelected ? 'ring-2 ring-foreground/70' : ''}
    {isPicked ? 'outline-2 outline-offset-2 outline-dashed outline-foreground/60' : ''}
    {dropState === 'ok' ? 'outline-2 outline-offset-2 outline-(--success)' : dropState === 'no' ? 'outline-2 outline-offset-2 outline-dashed outline-(--solus-status-error)' : ''}
    hover:border-foreground/25"
  style:left="{at.x}%"
  style:top="{at.y}%"
  style:width="{width}%"
  style:height="{CARD_HEIGHT}rem"
  style:opacity={isDimmed ? 0.35 : isFaded ? 0.45 : tone === "off" ? 0.75 : 1}
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
      data-fleet-stop
      tabindex={isCurrent ? 0 : -1}
      aria-pressed={isSelected}
      aria-label="{machine.label}, {machine.problem?.label ?? machine.state}{isPicked ? ', picked' : ''}"
      onclick={(event) => onSelect(machine.serverId, event.shiftKey)}
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
          tabindex="-1"
          onclick={() => onStart(machine.serverId)}
          class="relative z-10 inline-flex items-center gap-1 text-chrome-dense text-(--solus-text-secondary) hover:text-foreground"
        >
          <Power size={11} />Start
        </button>
      {:else}
        <HostStateIcon state={machine.state} label={machine.problem?.label} count={machine.state === "running" ? machine.sessions : undefined} />
      {/if}
      {#if machine.needsSetup}<HostStateIcon state="signin" />{/if}

      {#if machine.latencyMs !== null}
        <span class="ml-auto shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums">{machine.latencyMs} ms</span>
      {/if}
    </div>
  </div>
  {#if canIntroduce}
    <!-- The handle sits on the outer edge, where the lines between your hosts arrive. The keyboard uses the host's menu instead. -->
    <button
      type="button"
      tabindex="-1"
      aria-label="Drag onto another host to introduce {machine.label} to it"
      title="Drag onto another host to introduce them"
      onpointerdown={(event) => onHandleDown(event, machine.serverId)}
      class="absolute top-1/2 -left-2.5 z-20 grid size-5 -translate-y-1/2 cursor-crosshair touch-none place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground motion-reduce:transition-none pointer-coarse:opacity-100
        {isSelected ? 'opacity-100' : ''}"
    ><Plus size={11} /></button>
  {/if}
</div>
