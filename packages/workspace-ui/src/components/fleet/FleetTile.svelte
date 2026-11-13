<script lang="ts">
  import { machineMatches, tileFill, type FleetMachine, type TileColorMode } from "./lib/fleet-model";

  /** One host as one square, for a zone with more hosts than cards fit (D4).
   *  A stopped host is an outline; a problem keeps its color in every mode. */
  interface Props {
    machine: FleetMachine;
    colorMode: TileColorMode;
    size: number;
    query: string;
    isFocused: boolean;
    onPoint: (serverId: string | null) => void;
    onSelect: (serverId: string) => void;
  }

  let { machine, colorMode, size, query, isFocused, onPoint, onSelect }: Props = $props();

  const fill = $derived(tileFill(machine, colorMode));
</script>

<button
  type="button"
  tabindex="-1"
  aria-label="{machine.label}, {machine.state}"
  title={machine.label}
  onmouseenter={() => onPoint(machine.serverId)}
  onmouseleave={() => onPoint(null)}
  onclick={() => onSelect(machine.serverId)}
  class="pointer-events-auto rounded-[2px] transition-[background-color,opacity] duration-700 ease-out motion-reduce:transition-none
    {fill ? '' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'}
    {isFocused ? 'outline-2 outline-offset-1 outline-foreground' : ''}"
  style:width="{size}px"
  style:height="{size}px"
  style:background={fill ?? "transparent"}
  style:opacity={machineMatches(machine, query) ? 1 : 0.15}
></button>
