<script lang="ts">
  import Icon from "@iconify/svelte";
  import { tick } from "svelte";
  import {
    ChevronRight as CaretRightIcon,
    FileText as FileTextIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { FILE_ICON_VIEWBOX, FOLDER_ICON_PATH, getFileIconPath } from "../editor/fileIcons";
  import {
    diffSummaryStore,
    type DiffSummaryScope,
  } from "./diff-summary.store.svelte";
  import {
    buildDiffSummaryTree,
    changeRatio,
    flattenDiffTree,
    type DiffFolderNode,
  } from "./lib/diff-summary-tree";
  import { revealInTranscript } from "./lib/reveal-in-transcript";

  /**
   * §9 — the one card with no kicker and no title. In the transcript it arrives
   * collapsed to its count line, because a finished turn should not cost the
   * reader a screen before they have decided they care; embedded in the changed
   * files popover the decision is already made, so it opens on the tree. Either
   * way every folder inside it starts closed.
   * Opened, it is a directory tree, and every row is a control: a file opens
   * its diff in the secondary pane, a folder only discloses, and the two are
   * never the same click. A file row also trails a second control, because
   * reading the change and reading the file are different questions.
   */
  interface Props {
    tabId: string;
    /** Session summaries own their paths; turn summaries derive them from git stats. */
    changedFiles?: string[];
    scope?: DiffSummaryScope;
    /** Opens the diff pane — on one file, or on the whole change with no path. */
    onOpenDiff?: (filePath?: string) => void;
    /** Opens the file itself in the file pane. */
    onOpenFile?: (filePath: string) => void;
    /** Removes the card surface when a parent popover already provides it. */
    embedded?: boolean;
  }
  let {
    tabId,
    changedFiles,
    scope = { kind: "session" },
    onOpenDiff,
    onOpenFile,
    embedded = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  // The card sits in a tab, but the change it summarises belongs to the session.
  const sessionId = $derived(session.tabs[tabId]?.sessionId ?? "");

  $effect(() => diffSummaryStore.refresh(session, sessionId, scope, changedFiles));

  const tree = $derived(
    buildDiffSummaryTree(
      changedFiles,
      diffSummaryStore.statsFor(sessionId, scope),
    ),
  );

  let cardEl = $state<HTMLElement>();
  // Opening the popover is already the "show me the files" click, so it lands on
  // the top-level tree; only the transcript card arrives on its count line.
  let isExpanded = $state(embedded);
  let expanded = $state<ReadonlySet<string>>(new Set());
  let unfolded = $state<ReadonlySet<string>>(new Set());

  const rows = $derived(flattenDiffTree(tree, expanded, unfolded));

  /** The card sits at the very end of the transcript, so anything that grows it
   *  grows into the space the input bar covers. A popover has its own scroller
   *  and its own bounds, so only the transcript card reaches for the viewport. */
  async function reveal() {
    if (embedded) return;
    await tick();
    if (cardEl) revealInTranscript(cardEl);
  }

  function toggleCard() {
    isExpanded = !isExpanded;
    if (isExpanded) void reveal();
  }

  function toggleFolder(folder: DiffFolderNode) {
    const next = new Set(expanded);
    if (!next.delete(folder.path)) next.add(folder.path);
    expanded = next;
    void reveal();
  }

  function showAllIn(folderPath: string) {
    unfolded = new Set(unfolded).add(folderPath);
    void reveal();
  }

  const STATUS_LABEL = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" } as const;

  // Wider than the disclosure column it steps past, so nesting reads as nesting
  // at a glance rather than as a row that happens to start slightly late.
  const indentFor = (depth: number) =>
    `calc(var(--diff-row-pad) + ${depth} * var(--diff-indent))`;

  /** The row stays marked for as long as the pane still shows that file. */
  const openFilePath = $derived(
    router.overlay?.name === "diff" ? (router.overlay.params.filePath ?? null) : null,
  );
</script>

{#if tree.total > 0}
  <div
    bind:this={cardEl}
    class="diff-summary px-[0.8125rem] py-[0.6875rem] pointer-fine:[.is-laptop-display_&]:px-2.5 pointer-fine:[.is-laptop-display_&]:py-2 {embedded
      ? 'diff-summary-embedded'
      : 'rounded-2xl pointer-fine:[.is-laptop-display_&]:rounded-xl'}"
    data-testid="diff-summary"
  >
    <div class="diff-summary-header flex items-center gap-2">
      <button
        type="button"
        class="diff-header flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
        aria-expanded={isExpanded}
        onclick={toggleCard}
      >
        <CaretRightIcon
          size={10}
          weight="bold"
          class="shrink-0 text-(--muted-foreground) opacity-45 transition-transform duration-150 {isExpanded
            ? 'rotate-90'
            : ''}"
        />
        <span class="truncate text-transcript-meta text-(--muted-foreground)">
          {tree.total} file{tree.total === 1 ? "" : "s"} changed
          {#if tree.folderCount > 1}<span class="opacity-55">in {tree.folderCount} folders</span>{/if}
        </span>
        <span class="flex-1"></span>
        <span class="diff-add tabular-nums">+{tree.additions}</span>
        <span class="diff-del tabular-nums" class:is-zero={tree.deletions === 0}>−{tree.deletions}</span>
      </button>
      {#if onOpenDiff}
        <!-- Names the destination, not the verb. Reachable without opening the
             card, because "show me the diff" is the commonest thing to want. -->
        <button type="button" class="diff-open-all" onclick={() => onOpenDiff()}>Open in the diff pane</button>
      {/if}
    </div>

    {#if isExpanded}
      <div class="diff-body mt-[0.4375rem] flex flex-col gap-px">
        {#each rows as row (row.kind === "more" ? `more:${row.folderPath}` : row.kind === "file" ? row.node.path : `dir:${row.node.path}`)}
          {#if row.kind === "folder"}
            {@const ratio = changeRatio(row.node)}
            <button
              type="button"
              class="diff-row"
              style="padding-left:{indentFor(row.depth)}"
              aria-expanded={expanded.has(row.node.path)}
              onclick={() => toggleFolder(row.node)}
            >
              <CaretRightIcon
                size={9}
                weight="bold"
                class="shrink-0 text-(--muted-foreground) opacity-45 transition-transform duration-150 {expanded.has(
                  row.node.path,
                )
                  ? 'rotate-90'
                  : ''}"
              />
              <svg class="diff-icon text-(--muted-foreground)" viewBox={FILE_ICON_VIEWBOX} fill="currentColor">
                <path d={FOLDER_ICON_PATH} />
              </svg>
              <span class="diff-path font-mono truncate">{row.node.label}</span>
              <span class="shrink-0 font-mono text-transcript-meta text-(--muted-foreground) opacity-55">
                {row.node.fileCount}
              </span>
              <span class="flex-1"></span>
              <span class="diff-bar shrink-0 flex overflow-hidden rounded-full">
                <span class="diff-bar-add" style="width:{ratio.added}%"></span>
                <span class="diff-bar-del" style="width:{ratio.removed}%"></span>
              </span>
              <span class="diff-add tabular-nums" class:is-zero={row.node.additions === 0}>
                +{row.node.additions}
              </span>
              <span class="diff-del tabular-nums" class:is-zero={row.node.deletions === 0}>
                −{row.node.deletions}
              </span>
            </button>
          {:else if row.kind === "file"}
            {@const brandIcon = fileTypeIcon(row.node.name)}
            <div
              class="diff-file-row"
              class:is-open={openFilePath === row.node.path}
            >
              <button
                type="button"
                class="diff-row min-w-0 flex-1 overflow-hidden"
                style="padding-left:{indentFor(row.depth)}"
                aria-current={openFilePath === row.node.path ? "true" : undefined}
                title="{STATUS_LABEL[row.node.status]} · {row.node.path}"
                onclick={() => onOpenDiff?.(row.node.path)}
              >
                <!-- The status letter takes the disclosure column: a folder opens
                     there, a file has nothing to open and says what happened to
                     it instead. Both row kinds then share an icon and a label
                     column, so a file and its sibling folder line up. -->
                <span class="diff-status status-{row.node.status} font-mono shrink-0">{row.node.status}</span>
                {#if brandIcon}
                  <Icon icon={brandIcon} width="13" height="13" class="shrink-0" />
                {:else}
                  <!-- No brand logo for this type: the monochrome glyph still says
                       what kind of file it is, which is the point of the slot. -->
                  <svg class="diff-icon text-(--muted-foreground)" viewBox={FILE_ICON_VIEWBOX} fill="currentColor">
                    <path d={getFileIconPath(row.node.name)} />
                  </svg>
                {/if}
                <span class="diff-path font-mono truncate">{row.node.name}</span>
                <span class="flex-1"></span>
                <!-- The counts and the file-pane control share the trailing
                     slot: on a row the pointer is already on, "what can I do
                     with this file" has replaced "how much did it change". -->
                <span class="diff-file-counts">
                  <span class="diff-add tabular-nums" class:is-zero={row.node.additions === 0}>
                    +{row.node.additions}
                  </span>
                  <span class="diff-del tabular-nums" class:is-zero={row.node.deletions === 0}>
                    −{row.node.deletions}
                  </span>
                </span>
              </button>
              <!-- A deleted file has no source left to read, so the row keeps
                   only the diff. -->
              {#if onOpenFile && row.node.status !== "D"}
                <button
                  type="button"
                  class="diff-file-open"
                  title="Open {row.node.path} in the file pane"
                  aria-label="Open {row.node.path} in the file pane"
                  onclick={() => onOpenFile(row.node.path)}
                >
                  <FileTextIcon size={12} />
                </button>
              {/if}
            </div>
          {:else}
            <button
              type="button"
              class="diff-row"
              style="padding-left:{indentFor(row.depth)}"
              onclick={() => showAllIn(row.folderPath)}
            >
              <!-- Stands in for the disclosure and icon columns, so the text
                   starts on the same axis as the filenames it stands for. -->
              <span class="diff-label-offset shrink-0"></span>
              <span class="font-mono text-transcript-meta text-(--muted-foreground) opacity-55">
                {row.hidden} more in this folder
              </span>
              <span class="flex-1"></span>
              <span class="text-transcript-meta font-medium">Show</span>
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Three quarters of the reading column, collapsed and open alike, so the card
     reads as a footnote to the turn rather than another message in it. */
  .diff-summary {
    --diff-indent: 1.375rem;
    --diff-row-pad: 0.375rem;
    --diff-row-gap: 0.5rem;
    --diff-row-block-pad: 0.25rem;
    --diff-icon-size: 0.8125rem;
    --diff-bar-width: 2.125rem;

    width: 75%;
    background: var(--card);
    /* A step up from the transcript's shared hairline: this card is a control
       surface the reader clicks into, not prose, so its edge has to be findable
       before the pointer is on it. */
    box-shadow: 0 0 0 0.0625rem color-mix(in oklch, var(--foreground) 15%, transparent);
  }

  .diff-summary-embedded {
    width: 100%;
    background: transparent;
    box-shadow: none;
  }

  :global(html.is-laptop-display) .diff-summary {
    --diff-indent: 1.125rem;
    --diff-row-pad: 0.3125rem;
    --diff-row-gap: 0.375rem;
    --diff-row-block-pad: 0.1875rem;
    --diff-icon-size: 0.75rem;
    --diff-bar-width: 1.75rem;
  }

  :global(html.is-laptop-display) .diff-summary:not(.diff-summary-embedded) {
    width: 70%;
  }

  :global(html.is-laptop-display) .diff-summary-header {
    gap: 0.375rem;
  }

  /* The card is the last thing in the transcript, so an unbounded tree opens
     straight past the fold and under the input bar. Past this the tree scrolls
     inside the card and the card itself stays whole on screen. */
  .diff-body {
    max-height: min(24rem, 40vh);
    /* Bleeds past the card padding so a row's hover wash reads as full width;
       the scroller lives here rather than on each row, so the bleed has to be
       on the scroller too. */
    margin-inline: -0.375rem;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  :global(html.is-laptop-display) .diff-body {
    max-height: min(19rem, 36vh);
  }

  .diff-header {
    border: none;
    background: transparent;
    padding: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .diff-row {
    display: flex;
    align-items: center;
    gap: var(--diff-row-gap);
    border: none;
    border-radius: 0.375rem;
    padding: var(--diff-row-block-pad) var(--diff-row-pad);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .diff-row:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  /* A file row is two controls in one strip, so the wash and the open marker
     belong to the strip; the diff button inside it stops painting its own. */
  .diff-file-row {
    display: flex;
    align-items: center;
    border-radius: 0.375rem;
  }
  .diff-file-row:hover,
  .diff-file-row:focus-within {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }
  .diff-file-row.is-open {
    background: color-mix(in oklch, var(--primary) 6%, transparent);
    box-shadow: inset 0 0 0 0.03125rem color-mix(in oklch, var(--primary) 32%, transparent);
  }
  .diff-file-row .diff-row:hover {
    background: transparent;
  }

  .diff-file-open {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.3125rem;
    padding: var(--diff-row-block-pad) var(--diff-row-pad);
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }
  .diff-file-open:hover {
    color: var(--foreground);
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
  }

  .diff-file-counts {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--diff-row-gap);
  }

  /* A thumb has no hover, so on a touch client neither one can depend on it:
     the counts stay and the control is simply there beside them. */
  @media (hover: hover) {
    .diff-file-open {
      display: none;
    }
    .diff-file-row:hover .diff-file-open,
    .diff-file-row:focus-within .diff-file-open {
      display: flex;
    }
    .diff-file-row:hover .diff-file-counts,
    .diff-file-row:focus-within .diff-file-counts {
      display: none;
    }
  }

  .diff-icon {
    flex-shrink: 0;
    width: var(--diff-icon-size);
    height: var(--diff-icon-size);
    opacity: 0.75;
  }

  /* Exactly the caret's width, because it stands in the caret's column. */
  .diff-status {
    width: 0.5625rem;
    font-size: var(--text-transcript-meta);
  }

  /* Disclosure column + gap + icon column: what a row with neither has to skip
     to reach the label axis. */
  .diff-label-offset {
    width: 1.875rem;
  }
  .status-A {
    color: color-mix(in oklch, var(--chart-3) 62%, var(--foreground));
  }
  .status-M {
    color: color-mix(in oklch, var(--chart-2) 66%, var(--foreground));
  }
  .status-D {
    color: color-mix(in oklch, var(--destructive) 62%, var(--foreground));
  }
  .status-R {
    color: color-mix(in oklch, var(--chart-4) 66%, var(--foreground));
  }

  .diff-path {
    min-width: 0;
    font-size: var(--text-transcript-meta);
  }

  /* The only place in the transcript where colour carries meaning rather than
     depth: a sign alone is too quiet to scan down a list. */
  .diff-add,
  .diff-del {
    flex-shrink: 0;
    font-size: var(--text-transcript-meta);
    font-variant-numeric: tabular-nums;
  }
  .diff-add {
    color: var(--chart-3);
  }
  .diff-del {
    color: var(--destructive);
  }
  .diff-add.is-zero,
  .diff-del.is-zero {
    color: inherit;
    opacity: 0.3;
  }

  /* Folder rows only: the one place a row stands for many files, so the split
     between added and removed is worth a shape as well as two numbers. */
  .diff-bar {
    width: var(--diff-bar-width);
    height: 0.1875rem;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
  }
  .diff-bar-add {
    background: color-mix(in oklch, var(--chart-3) 62%, transparent);
  }
  .diff-bar-del {
    background: color-mix(in oklch, var(--destructive) 55%, transparent);
  }

  .diff-open-all {
    flex-shrink: 0;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--solus-text-primary);
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    cursor: pointer;
  }
  .diff-open-all:hover {
    text-decoration: underline;
    text-underline-offset: 0.15625rem;
  }
</style>
