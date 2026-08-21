<script lang="ts">
  interface DrillCrumb {
    id: string;
    label: string;
  }

  interface Props {
    /** The diagram itself — the level the trail returns to at depth 0. */
    rootLabel: string;
    /** Levels drilled into, outermost first. Empty renders nothing. */
    path: DrillCrumb[];
    /** Depth to return to: 0 is the diagram, 1 the first detail, and so on. */
    onNavigate: (depth: number) => void;
    /** Tooltip on the root crumb; hosts with a shortcut for it say so here. */
    rootTitle?: string;
  }

  let { rootLabel, path, onNavigate, rootTitle }: Props = $props();
</script>

<!-- The only way back out of a sub-diagram, so it floats over the canvas rather
     than living in chrome. Styling is the shared `.drill-crumbs` /
     `.diagram-shell__crumb*` chrome in DiagramShell.css. -->
{#if path.length > 0}
  <nav class="drill-crumbs" aria-label="Diagram breadcrumb">
    <button
      type="button"
      class="diagram-shell__crumb"
      onclick={() => onNavigate(0)}
      title={rootTitle ?? `Back to ${rootLabel}`}
    >
      {rootLabel}
    </button>
    {#each path as crumb, i (crumb.id ?? i)}
      <span class="diagram-shell__crumb-sep" aria-hidden="true">›</span>
      {#if i === path.length - 1}
        <span class="diagram-shell__crumb diagram-shell__crumb--current" aria-current="page">
          {crumb.label}
        </span>
        <!-- Says what kind of level you are standing on, so a nested graph never
             reads as the diagram itself. -->
        <span class="diagram-shell__crumb-tag">detail</span>
      {:else}
        <button
          type="button"
          class="diagram-shell__crumb"
          onclick={() => onNavigate(i + 1)}
          title="Back to {crumb.label}"
        >
          {crumb.label}
        </button>
      {/if}
    {/each}
  </nav>
{/if}
