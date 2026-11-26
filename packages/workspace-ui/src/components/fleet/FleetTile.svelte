<script lang="ts">
  import { machineMatches, tileFill, type FleetMachine, type TileColorMode } from "./lib/fleet-model";

  /** One host as one square, for a zone with more hosts than cards fit. A
   *  stopped host is an outline, and a problem keeps its color in every mode.
   *  Every tile is one square: the zone's summary row above the tiles counts each
   *  state with an icon, and each tile names its state to the pointer and to
   *  assistive tech, so the state is never in the color alone. A click selects it, a click on the selected tile opens
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
    /** While a handle is dragged over it: whether the drop would introduce. */
    dropState: "ok" | "no" | null;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string, isAdding: boolean) => void;
  }

  let { machine, colorMode, size, query, isFocused, isSelected, isPicked, isCurrent, dropState, onPoint, onSelect }: Props = $props();

  const fill = $derived(tileFill(machine, colorMode));
</script>

<button
  type="button"
  data-fleet-stop
  tabindex={isCurrent ? 0 : -1}
  data-host-id={machine.serverId}
  aria-pressed={isSelected}
  aria-label="{machine.label}, {machine.problem?.label ?? machine.state}{isPicked ? ', picked' : ''}"
  title="{machine.label}: {machine.problem?.label ?? machine.state}"
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  onfocus={() => onPoint(machine.serverId)}
  onblur={() => onPoint(null)}
  onclick={(event) => onSelect(machine.serverId, event.shiftKey)}
  class="pointer-events-auto transition-[background-color,opacity] duration-700 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring motion-reduce:transition-none forced-colors:border forced-colors:border-[CanvasText]
    rounded-[2px]
    {fill ? '' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'}
    {dropState === 'ok' ? 'outline-2 outline-offset-1 outline-(--success)' : dropState === 'no' ? 'outline-2 outline-offset-1 outline-dashed outline-(--solus-status-error)' : isFocused || isSelected ? 'outline-2 outline-offset-1 outline-foreground' : isPicked ? 'outline-2 outline-offset-1 outline-dashed outline-foreground' : ''}"
  style:width="{size}px"
  style:height="{size}px"
  style:background={fill ?? "transparent"}
  style:opacity={machineMatches(machine, query) ? 1 : 0.15}
></button>
