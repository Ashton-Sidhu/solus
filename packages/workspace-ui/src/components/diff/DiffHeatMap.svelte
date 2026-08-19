<script lang="ts">
  import { CaretRightIcon } from "phosphor-svelte";
  import type { FileDiffMetadata } from "@pierre/diffs";
  import {
    buildHeatMapTree,
    heatBreadcrumb,
    heatChanges,
    heatIntensity,
    heatNodeAtPath,
    layoutTreemap,
    type HeatMapNode,
  } from "./lib/heat-map";

  let {
    files,
    onOpenFile,
    repoRoot = null,
    loadRepoFiles,
  }: {
    files: FileDiffMetadata[];
    /** Display path of a changed file cell the user clicked, to open in the diff. */
    onOpenFile: (displayPath: string) => void;
    /** Repo root to list unchanged files from; null keeps a changed-only map. */
    repoRoot?: string | null;
    loadRepoFiles?: (repoRoot: string) => Promise<readonly string[] | null>;
  } = $props();

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
    const pct = Math.round(8 + heatIntensity(node, maxChanges) * 52);
    return `background: color-mix(in srgb, var(--solus-accent) ${pct}%, var(--solus-surface-hover))`;
  }

  function nodeTitle(node: HeatMapNode): string {
    if (!node.changed) return `${node.path} — unchanged`;
    const stats = `+${node.additions} −${node.deletions}`;
    return node.kind === "folder"
      ? `${node.path} — ${node.changedFileCount} of ${node.totalFileCount} file${node.totalFileCount === 1 ? "" : "s"} changed, ${stats}`
      : `${node.path} — ${stats}`;
  }

  let mapWidth = $state(0);
  let mapHeight = $state(0);
  const treemapRects = $derived(
    layoutTreemap(current.children, mapWidth, mapHeight),
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="text-xs flex h-full min-h-0 flex-col gap-3 p-4"
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
    <div class="flex shrink-0 items-center gap-3">
      <span class="text-xs tabular-nums text-(--solus-text-tertiary)">
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
      <span class="flex items-center gap-1.5" aria-hidden="true">
        <span class="h-1.5 w-3 rounded-full bg-(--solus-surface-hover)"></span>
        <span class="text-xs text-(--solus-text-tertiary)"
          >unchanged</span
        >
        <span
          class="ml-1.5 h-1.5 w-16 rounded-full"
          style="background: linear-gradient(to right, color-mix(in srgb, var(--solus-accent) 8%, var(--solus-surface-hover)), color-mix(in srgb, var(--solus-accent) 60%, var(--solus-surface-hover)))"
        ></span>
        <span class="text-xs text-(--solus-text-tertiary)">changed</span
        >
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
        class="absolute cursor-pointer overflow-hidden rounded-md border-2 border-(--solus-container-bg) text-left hover:brightness-105 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-(--solus-accent) dark:hover:brightness-125"
        style="left:{rect.left}px; top:{rect.top}px; width:{rect.width}px; height:{rect.height}px; {heatTint(
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
