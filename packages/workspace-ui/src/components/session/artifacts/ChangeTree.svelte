<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { ChevronRight as CaretIcon } from "@lucide/svelte";
  import { flattenDiffTree, type DiffFolderNode, type DiffTree } from "../../conversation/lib/diff-summary-tree";
  import FileIcon from "../../ui/file-icon/FileIcon.svelte";
  import LineCounts from "./LineCounts.svelte";
  import { folderPaths } from "./lib/change-tree";

  /**
   * The changed files as the directory tree the conversation's
   * changed-files card draws: a chain of single-child folders is one row, a
   * folder discloses, and a file opens its diff. The disclosure column holds a
   * folder's caret and a file's status letter, so both kinds of row share one
   * icon column and one label column.
   */
  interface Props {
    tree: DiffTree;
    /** Git has answered: the rows carry counts and status letters. */
    counted: boolean;
    /** Whether the folders start open: a small change, or a search. */
    startsOpen: boolean;
    /** Opens a file's diff. Absent when the session has no conversation open to show it in. */
    onOpen?: (path: string) => void;
  }
  let { tree, counted, startsOpen, onOpen }: Props = $props();

  /** The folders the reader opened or closed by hand; the others follow `startsOpen`. */
  const toggled = new SvelteMap<string, boolean>();
  const unfolded = new SvelteSet<string>();

  const expanded = $derived(new Set(folderPaths(tree).filter((path) => toggled.get(path) ?? startsOpen)));
  const rows = $derived(flattenDiffTree(tree, expanded, unfolded));

  function toggleFolder(folder: DiffFolderNode) {
    toggled.set(folder.path, !expanded.has(folder.path));
  }

  const STATUS_LABEL = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" };
  // The tones the conversation's changed-files card gives its status letters.
  const STATUS_TONE = {
    A: "text-[color-mix(in_oklch,var(--chart-3)_62%,var(--foreground))]",
    M: "text-[color-mix(in_oklch,var(--chart-2)_66%,var(--foreground))]",
    D: "text-[color-mix(in_oklch,var(--destructive)_62%,var(--foreground))]",
    R: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
  };
</script>

<div class="flex flex-col gap-px" data-testid="artifacts-change-tree">
  {#each rows as row (row.kind === "more" ? `more:${row.folderPath}` : row.kind === "file" ? row.node.path : `dir:${row.node.path}`)}
    {#if row.kind === "folder"}
      <button
        type="button"
        aria-expanded={expanded.has(row.node.path)}
        title={row.node.path}
        class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent pr-2 text-left text-workspace-chrome text-(--solus-text-secondary) transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
        style:padding-left="calc(0.5rem + {row.depth} * 1.125rem)"
        onclick={() => toggleFolder(row.node)}
      >
        <CaretIcon
          size={12}
          class="w-3 shrink-0 text-muted-foreground opacity-60 transition-transform duration-(--duration-base) ease-(--ease-premium) motion-reduce:transition-none {expanded.has(
            row.node.path,
          )
            ? 'rotate-90'
            : ''}"
        />
        <FileIcon path="{row.node.path}/" size={16} />
        <span class="min-w-0 shrink truncate">{row.node.label}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground opacity-70">{row.node.fileCount}</span>
        <span class="flex-1"></span>
        {#if counted}<LineCounts columns additions={row.node.additions} deletions={row.node.deletions} />{/if}
      </button>
    {:else if row.kind === "file"}
      {@const deleted = counted && row.node.status === "D"}
      <button
        type="button"
        title={counted ? `${row.node.path}\n${STATUS_LABEL[row.node.status]}` : row.node.path}
        disabled={!onOpen}
        class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent pr-2 text-left text-workspace-chrome text-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-11"
        style:padding-left="calc(0.5rem + {row.depth} * 1.125rem)"
        data-testid="artifacts-change-row"
        onclick={() => onOpen?.(row.node.path)}
      >
        <span
          class="w-3 shrink-0 text-center font-mono text-[11px] {counted ? STATUS_TONE[row.node.status] : ''}"
          aria-label={counted ? STATUS_LABEL[row.node.status] : undefined}
        >
          {counted ? row.node.status : ""}
        </span>
        <FileIcon path={row.node.path} size={16} class={deleted ? "opacity-50" : ""} />
        <span class="min-w-0 shrink truncate {deleted ? 'text-muted-foreground line-through' : ''}">{row.node.name}</span>
        <span class="flex-1"></span>
        {#if counted}<LineCounts columns additions={row.node.additions} deletions={row.node.deletions} />{/if}
      </button>
    {:else}
      <button
        type="button"
        class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent pr-2 text-left text-xs text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
        style:padding-left="calc(0.5rem + {row.depth} * 1.125rem)"
        onclick={() => unfolded.add(row.folderPath)}
      >
        <!-- Stands in for the disclosure and icon columns, so the text starts where the file names do. -->
        <span class="w-9 shrink-0"></span>
        <span class="min-w-0 truncate">{row.hidden} more in this folder</span>
      </button>
    {/if}
  {/each}
</div>
