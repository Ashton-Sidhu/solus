<script lang="ts">
  import { isTwoWay, REACH_HEALTH_LABELS, REACH_STYLES, reachNeedsAttention, type ReachPath } from "./lib/fleet-reach";

  /** The lines between your hosts that reach each other, on the outer side of
   *  Your machines. A line ends in an arrowhead at each host that is reached, so a
   *  two-way line has one at each end. A healthy line stays neutral; each kind of
   *  trouble has its own dash and color, and stays clear when another host is in
   *  focus. A click on a line selects it. */
  interface Props {
    paths: ReachPath[];
    selectedEdgeId: string | null;
    /** The host selected or pointed at: lines that do not touch it step back. */
    focusId: string | null;
    labelOf: (serverId: string) => string;
    onSelectEdge: (edgeId: string) => void;
  }

  let { paths, selectedEdgeId, focusId, labelOf, onSelectEdge }: Props = $props();

  const isLit = (path: ReachPath) =>
    path.edge.id === selectedEdgeId || (!focusId && !selectedEdgeId) || path.edge.a === focusId || path.edge.b === focusId || reachNeedsAttention(path.edge.health);
  const lineName = (path: ReachPath) => {
    const [a, b] = [labelOf(path.edge.a), labelOf(path.edge.b)];
    const ways = isTwoWay(path.edge) ? `${a} and ${b} reach each other` : path.edge.forward ? `${a} reaches ${b}` : `${b} reaches ${a}`;
    return `${ways}: ${REACH_HEALTH_LABELS[path.edge.health]}`;
  };
</script>

<svg class="pointer-events-none absolute inset-0 z-5 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
  {#each paths as path (path.edge.id)}
    {@const style = REACH_STYLES[path.edge.health]}
    {@const selected = path.edge.id === selectedEdgeId}
    <g opacity={isLit(path) ? 1 : 0.25}>
      <path d={path.d} fill="none" vector-effect="non-scaling-stroke" stroke-linejoin="round"
        stroke-width={style.width + (selected ? 1 : 0)} stroke-dasharray={style.dash ?? undefined} style:stroke={style.color} />
      <!-- A wide, clear stroke over the line, so a click need not land on a hairline. -->
      <path
        d={path.d}
        fill="none"
        vector-effect="non-scaling-stroke"
        stroke-width="10"
        stroke="transparent"
        class="cursor-pointer"
        style:pointer-events="stroke"
        role="button"
        tabindex="-1"
        aria-label={lineName(path)}
        onclick={(event) => { event.stopPropagation(); onSelectEdge(path.edge.id); }}
        onkeydown={(event) => { if (event.key === "Enter") onSelectEdge(path.edge.id); }}
      ><title>{lineName(path)}</title></path>
    </g>
  {/each}
</svg>

<!-- Arrowheads into each host that is reached, drawn in px so the map's stretch does not bend them. -->
{#each paths as path (path.edge.id)}
  {#each path.ends as end (end.serverId)}
    {#if end.isReached}
      <svg
        aria-hidden="true"
        viewBox="0 0 6 8"
        class="pointer-events-none absolute z-5 h-2 w-1.5 -translate-x-full -translate-y-1/2"
        style:left="{end.point.x}%"
        style:top="{end.point.y}%"
        style:color={REACH_STYLES[path.edge.health].color}
        style:opacity={isLit(path) ? 1 : 0.25}
      ><path d="M0 0L6 4L0 8Z" fill="currentColor" /></svg>
    {/if}
  {/each}
{/each}
