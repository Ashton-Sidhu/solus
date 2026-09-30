<script lang="ts">
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import type { FileDiffMetadata } from "@pierre/diffs";
  import { cn } from "../../lib/tw";
  import {
    buildHeatMapTree,
    heatBreadcrumb,
    heatChanges,
    heatIntensity,
    heatNodeAtPath,
    heatTone,
    layoutTreemap,
    type HeatMapNode,
    type HeatTone,
  } from "./lib/heat-map";

  let {
    files,
    onOpenFile,
    repoRoot = null,
    loadRepoFiles,
    class: className = "",
  }: {
    files: FileDiffMetadata[];
    /** Display path of a changed file cell the user clicked, to open in the diff. */
    onOpenFile: (displayPath: string) => void;
    /** Repo root to list unchanged files from; null keeps a changed-only map. */
    repoRoot?: string | null;
    loadRepoFiles?: (repoRoot: string) => Promise<readonly string[] | null>;
    /** The map's inset and type size. A pane uses the defaults; a card that
     *  pads its own body, or sets its own type, passes them here. */
    class?: string;
  } = $props();

  /** The hue a changed cell is tinted with — the same colours the map prints
   *  its `+N` and `−N` in, so the tint and the numbers agree. */
  const TONE_COLORS = {
    added: "var(--solus-art-3)",
    removed: "var(--solus-stop-bg)",
    mixed: "var(--solus-accent)",
  } satisfies Record<HeatTone, string>;

  const LEGEND: ReadonlyArray<[HeatTone, string]> = [
    ["added", "Added"],
    ["mixed", "Rewritten"],
    ["removed", "Removed"],
  ];

  /** The gap between cells, taken out of each cell rather than painted as a
   *  border, so the map sits on any surface without a seam colour to match. */
  const CELL_GAP_PX = 3;

  // Unchanged repo structure, fetched once per root so the map shows the whole
  // repository, not just the changed slice. `loadedRoot` guards both re-entry
  // and a stale response landing after the root changed.
  let repoFiles = $state<readonly string[] | null>(null);
  let loadedRoot: string | null = null;
  $effect(() => {
    const root = repoRoot;
    if (!root || !loadRepoFiles || loadedRoot === root) return;
    loadedRoot = root;
    loadRepoFiles(root)
      .then((paths) => {
        if (loadedRoot === root) repoFiles = paths;
      })
      .catch(() => {
        if (loadedRoot === root) repoFiles = null;
      });
  });

  const root = $derived(buildHeatMapTree(files, repoFiles ?? undefined));
  let drillPath = $state("");
  // A refresh can drop the drilled folder from the diff; fall back to the root
  // rather than rendering a dead level.
  const current = $derived(heatNodeAtPath(root, drillPath) ?? root);
  const trail = $derived(heatBreadcrumb(root, current.path));
  const maxChanges = $derived(
    current.children.reduce((max, c) => Math.max(max, heatChanges(c)), 0),
  );

  function open(node: HeatMapNode) {
    if (node.kind === "folder") drillPath = node.path;
    else if (node.changed) onOpenFile(node.path);
  }

  function drillUp() {
    if (trail.length === 0) return;
    drillPath = trail.length > 1 ? trail[trail.length - 2].path : "";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Backspace" && current.path) {
      event.preventDefault();
      drillUp();
    }
  }

  function heatTint(node: HeatMapNode): string {
    if (!node.changed) return "background: var(--solus-surface-hover)";
    const pct = Math.round(12 + heatIntensity(node, maxChanges) * 46);
    return `background: color-mix(in oklab, ${TONE_COLORS[heatTone(node)]} ${pct}%, var(--solus-surface-hover))`;
  }

  function nodeTitle(node: HeatMapNode): string {
    if (!node.changed) return `${node.path} — unchanged`;
    const stats = `+${node.additions} −${node.deletions}`;
    return node.kind === "folder"
      ? `${node.path} — ${node.changedFileCount} of ${node.totalFileCount} file${node.totalFileCount === 1 ? "" : "s"} changed, ${stats}`
      : `${node.path} — ${node.status === "A" ? "new file, " : node.status === "D" ? "deleted, " : ""}${stats}`;
  }

  let mapWidth = $state(0);
  let mapHeight = $state(0);
  const treemapRects = $derived(
    layoutTreemap(current.children, mapWidth, mapHeight),
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class={cn("flex h-full min-h-0 flex-col gap-3 p-4 text-xs", className)}
  role="region"
  aria-label="Change heat map"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <nav
      class="flex min-w-0 items-center gap-0.5"
      aria-label="Heat map location"
    >
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 font-medium hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) {trail.length ===
        0
          ? 'text-(--solus-text-primary)'
          : 'text-(--solus-text-secondary)'}"
        onclick={() => (drillPath = "")}
      >
        All changes
      </button>
      {#each trail as crumb (crumb.path)}
        <CaretRightIcon
          size={12}
          class="shrink-0 text-(--solus-text-tertiary)"
        />
        <button
          type="button"
          class="min-w-0 cursor-pointer truncate rounded-md px-1.5 py-0.5 font-medium hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) {crumb.path ===
          current.path
            ? 'text-(--solus-text-primary)'
            : 'text-(--solus-text-secondary)'}"
          onclick={() => (drillPath = crumb.path)}
        >
          {crumb.name}
        </button>
      {/each}
    </nav>
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
      <span class="tabular-nums text-(--solus-text-tertiary)">
        {#if current.totalFileCount > current.changedFileCount}
          {current.changedFileCount} of {current.totalFileCount} files changed
        {:else}
          {current.changedFileCount} file{current.changedFileCount === 1
            ? ""
            : "s"} changed
        {/if}
        <span class="font-medium" style="color:var(--solus-art-3)"
          >+{current.additions}</span
        >
        <span class="font-medium" style="color:var(--solus-stop-bg)"
          >−{current.deletions}</span
        >
      </span>
      <!-- The legend names the hues; the strength of a tint is the heat, and
           the tooltip on any cell gives its numbers. -->
      <span class="flex items-center gap-3 text-(--solus-text-tertiary)" aria-hidden="true">
        {#each LEGEND as [tone, label] (tone)}
          <span class="flex items-center gap-1.5">
            <span
              class="size-2.5 rounded-[3px]"
              style="background: color-mix(in oklab, {TONE_COLORS[tone]} 52%, var(--solus-surface-hover))"
            ></span>
            {label}
          </span>
        {/each}
      </span>
    </div>
  </div>

  <div
    class="relative min-h-0 flex-1 overflow-hidden rounded-lg"
    bind:clientWidth={mapWidth}
    bind:clientHeight={mapHeight}
  >
    {#each treemapRects as rect (rect.node.path)}
      <button
        type="button"
        class="absolute cursor-pointer overflow-hidden rounded-md text-left transition-shadow hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_28%,transparent)] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-(--solus-accent)"
        style="left:{rect.left}px; top:{rect.top}px; width:{Math.max(rect.width - CELL_GAP_PX, 0)}px; height:{Math.max(rect.height - CELL_GAP_PX, 0)}px; {heatTint(
          rect.node,
        )}"
        title={nodeTitle(rect.node)}
        onclick={() => open(rect.node)}
      >
        {#if rect.width > 72 && rect.height > 36}
          <div class="flex h-full flex-col justify-between p-1.5">
            <span
              class="truncate font-medium {rect.node.changed
                ? 'text-(--solus-text-primary)'
                : 'text-(--solus-text-tertiary)'}"
            >
              {rect.node.name}{rect.node.kind === "folder" ? "/" : ""}
            </span>
            {#if rect.node.changed}
              <span
                class="flex items-center gap-1.5 overflow-hidden whitespace-nowrap tabular-nums text-(--solus-text-secondary)"
              >
                {#if rect.node.kind === "folder"}
                  <span>{rect.node.changedFileCount}f</span>
                {:else if rect.node.status === "A"}
                  <span>new</span>
                {/if}
                <span class="font-medium" style="color:var(--solus-art-3)"
                  >+{rect.node.additions}</span
                >
                <span class="font-medium" style="color:var(--solus-stop-bg)"
                  >−{rect.node.deletions}</span
                >
              </span>
            {/if}
          </div>
        {/if}
      </button>
    {/each}
  </div>
</div>
