<script lang="ts">
  import { machineMatches, tileFill, toneOf, type FleetMachine, type TileColorMode } from "./lib/fleet-model";

  /** One host as one square, for a zone with more hosts than cards fit. A
   *  stopped host is an outline; a problem keeps its color in every mode, and its
   *  shape says it without color: a diamond when it does not answer, a circle
   *  while it reconnects. A click selects it, a click on the selected tile opens
   *  it, and Shift-click picks it. */
  interface Props {
    machine: FleetMachine;
    colorMode: TileColorMode;
    size: number;
    query: string;
    isFocused: boolean;
    isSelected: boolean;
    isPicked: boolean;
    /** The one host of the map that Tab reaches. */
    isCurrent: boolean;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string, isAdding: boolean) => void;
  }

  let { machine, colorMode, size, query, isFocused, isSelected, isPicked, isCurrent, onPoint, onSelect }: Props = $props();

  const fill = $derived(tileFill(machine, colorMode));
  const tone = $derived(toneOf(machine.state));
</script>

<button
  type="button"
  data-fleet-stop
  tabindex={isCurrent ? 0 : -1}
  data-host-id={machine.serverId}
  aria-pressed={isSelected}
  aria-label="{machine.label}, {machine.problem?.label ?? machine.state}{isPicked ? ', picked' : ''}"
  title={machine.label}
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  onfocus={() => onPoint(machine.serverId)}
  onblur={() => onPoint(null)}
  onclick={(event) => onSelect(machine.serverId, event.shiftKey)}
  class="pointer-events-auto transition-[background-color,opacity] duration-700 ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring motion-reduce:transition-none forced-colors:border forced-colors:border-[CanvasText]
    {tone === 'bad' ? 'scale-[0.8] rotate-45 rounded-[1px]' : tone === 'warn' ? 'rounded-full' : 'rounded-[2px]'}
    {fill ? '' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'}
    {isFocused || isSelected ? 'outline-2 outline-offset-1 outline-foreground' : isPicked ? 'outline-2 outline-offset-1 outline-dashed outline-foreground/70' : ''}"
  style:width="{size}px"
  style:height="{size}px"
  style:background={fill ?? "transparent"}
  style:opacity={machineMatches(machine, query) ? 1 : 0.15}
></button>
