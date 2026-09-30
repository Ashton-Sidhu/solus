<script lang="ts">
  import { Dialog } from "bits-ui";
  import { RotateCcw as RestoreIcon, X as XIcon } from "@lucide/svelte";
  import type { WorkType } from "@solus/contracts/types";
  import { getSurfaceContext, presenceStore } from "../../contexts";
  import { Button } from "../ui/button";
  import Diff from "../diff/Diff.svelte";
  import GithubMarkdown from "../github-markdown/GithubMarkdown.svelte";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import { attributionName } from "../presence/lib/actor-name";
  import { relativeTime } from "../../lib/relative-time";
  import { toasts } from "../../lib/toasts";
  import { getWorkPaneContext } from "./lib/work-pane-context";
  import {
    diagramRevisionDiff,
    historyPoints,
    historyRows,
    markdownBlockDiff,
    pointBefore,
    revisionReasonLabel,
    type HistoryPoint,
  } from "./lib/work-history";

  interface Props {
    open: boolean;
    workId: string;
    title: string;
    type: WorkType;
    /** The body on screen now, unsaved edits included. */
    currentContent: () => string;
    /** Open on this point instead of the newest one. `current` opens on the
     *  newest point when a checkpoint already holds the current body. */
    initialPick?: HistoryPoint | null;
    /** Compare against this point instead of the one before the picked one. */
    initialBase?: HistoryPoint | null;
  }

  let { open = $bindable(), workId, title, type, currentContent, initialPick = null, initialBase = null }: Props = $props();

  const session = getSurfaceContext();
  const pane = getWorkPaneContext();
  const history = session.worksStore.history;

  const serverId = $derived(session.worksStore.hostFor(workId));
  const self = $derived(serverId ? presenceStore.currentUserId(serverId) : null);
  const revisions = $derived(history.revisions.get(workId) ?? null);
  const rows = $derived(revisions ? historyRows(revisions) : []);
  const rowById = $derived(new Map(rows.map((row) => [row.revisionId, row])));
  const currentHash = $derived(session.worksStore.savedWork(workId)?.contentHash ?? "");
  const points = $derived(historyPoints(rows, currentHash));
  const loadError = $derived(history.errors.get(workId) ?? null);

  let picked = $state<HistoryPoint | null>(null);
  /** The comparison base the reader chose; null follows the picked point. */
  let chosenBase = $state<HistoryPoint | null>(null);
  let sourceView = $state(false);
  let restoring = $state(false);

  $effect(() => {
    if (!open) return;
    picked = null;
    chosenBase = initialBase;
    void history.load(workId);
  });

  // Once the list arrives, pick the requested point or the newest one.
  const activePick = $derived<HistoryPoint | null>(
    picked ?? (initialPick !== null && initialPick !== "current" && rowById.has(initialPick) ? initialPick : (points[0] ?? null)),
  );
  const base = $derived(chosenBase ?? (activePick === null ? null : pointBefore(points, activePick)));

  let bodies = $state<{ key: string; before: string; after: string } | null>(null);
  let bodyError = $state<string | null>(null);
  const comparisonKey = $derived(activePick === null ? null : `${base ?? "none"}→${activePick}`);

  async function bodyOf(point: HistoryPoint | null): Promise<string> {
    if (point === null) return "";
    if (point === "current") return currentContent();
    return history.body(workId, point);
  }

  $effect(() => {
    const key = comparisonKey;
    const from = base;
    const to = activePick;
    if (!open || key === null) return;
    bodyError = null;
    void Promise.all([bodyOf(from), bodyOf(to)]).then(
      ([before, after]) => {
        if (comparisonKey === key) bodies = { key, before, after };
      },
      (error: Error) => {
        if (comparisonKey === key) bodyError = error.message;
      },
    );
  });

  const shown = $derived(bodies && bodies.key === comparisonKey ? bodies : null);
  const blocks = $derived(shown && (type === "doc" || type === "slides") && !sourceView ? markdownBlockDiff(shown.before, shown.after) : []);
  const diagramDiff = $derived(shown && type === "diagram" ? diagramRevisionDiff(shown.before, shown.after) : null);

  function pointLabel(point: HistoryPoint): string {
    if (point === "current") return "Current version";
    const row = rowById.get(point);
    return row ? `${revisionReasonLabel(row.reason)} · ${relativeTime(Date.parse(row.capturedAt))}` : `Version ${point}`;
  }

  function authorOf(point: HistoryPoint): string | null {
    if (point === "current") return null;
    const author = rowById.get(point)?.author;
    return author ? attributionName(author, self) : null;
  }

  /** The checkpoint picked, when the pick is one rather than the current body. */
  const pickedRevisionId = $derived(activePick === null || activePick === "current" ? null : activePick);
  const canRestore = $derived(
    !!pane && pane.canEdit() && pickedRevisionId !== null && rowById.get(pickedRevisionId)?.contentHash !== currentHash,
  );

  async function restore() {
    if (!pane || pickedRevisionId === null) return;
    if (pane.isDirty()) {
      toasts.error("Save or discard your edits before you restore a version.");
      return;
    }
    restoring = true;
    try {
      await pane.restoreRevision(pickedRevisionId);
      toasts.success("Version restored", { description: "The restore is a new version. Nothing was deleted." });
      open = false;
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    } finally {
      restoring = false;
    }
  }

  function moveSelection(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (activePick === null) return;
    const index = points.indexOf(activePick);
    const next = points[event.key === "ArrowDown" ? index + 1 : index - 1];
    if (next === undefined) return;
    event.preventDefault();
    picked = next;
    chosenBase = null;
    document.querySelector<HTMLElement>(`[data-history-point="${next}"]`)?.focus();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-(--solus-modal-scrim)" />
    <Dialog.Content
      class="@container/history text-workspace-chrome fixed top-1/2 left-1/2 z-50 flex h-[min(52rem,calc(100dvh-1rem))] w-[min(76rem,calc(100vw-1rem))] -translate-1/2 flex-col overflow-hidden rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) shadow-(--solus-popover-shadow)"
      data-testid="work-history"
    >
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-tool-border) px-4 py-2.5">
        <Dialog.Title class="min-w-0 truncate font-medium text-(--solus-text-primary)">History of “{title}”</Dialog.Title>
        <div class="flex shrink-0 items-center gap-1.5">
          {#if type === "doc" || type === "slides"}
            <Button variant="ghost" size="xs" class="pointer-coarse:min-h-11" aria-pressed={sourceView} onclick={() => (sourceView = !sourceView)}>
              {sourceView ? "Rendered" : "Markdown"}
            </Button>
          {/if}
          {#if canRestore}
            <Button variant="outline" size="xs" class="pointer-coarse:min-h-11" data-testid="restore-version" disabled={restoring} onclick={() => void restore()}>
              <RestoreIcon size={13} />
              {restoring ? "Restoring…" : "Restore this version"}
            </Button>
          {/if}
          <Dialog.Close>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-xs" class="pointer-coarse:size-11" aria-label="Close history"><XIcon size={16} /></Button>
            {/snippet}
          </Dialog.Close>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col @min-[48rem]/history:flex-row">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <ol
          class="flex max-h-[30%] shrink-0 flex-col gap-0.5 overflow-y-auto border-b border-(--solus-tool-border) p-2 @min-[48rem]/history:max-h-none @min-[48rem]/history:w-72 @min-[48rem]/history:border-r @min-[48rem]/history:border-b-0"
          aria-label="Versions"
          onkeydown={moveSelection}
        >
          {#if !revisions && !loadError}
            <li class="px-2 py-1.5 text-(--solus-text-tertiary)">Loading history…</li>
          {:else if loadError && !revisions}
            <li class="flex items-center justify-between gap-2 px-2 py-1.5 text-(--solus-text-secondary)">
              <span class="min-w-0">Could not load the history.</span>
              <Button variant="outline" size="xs" onclick={() => void history.load(workId)}>Retry</Button>
            </li>
          {/if}
          {#each points as point (point)}
            {@const author = authorOf(point)}
            <li>
              <button
                type="button"
                data-history-point={point}
                class="flex w-full min-w-0 flex-col items-start gap-0.5 overflow-hidden rounded-lg px-2.5 py-1.5 text-left hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:min-h-11 {point === activePick ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}"
                aria-current={point === activePick}
                onclick={() => { picked = point; chosenBase = null; }}
              >
                <span class="w-full truncate">{pointLabel(point)}</span>
                {#if author}
                  <span class="w-full truncate text-(--solus-text-tertiary)">by {author}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ol>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          {#if activePick !== null}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--solus-tool-border) px-4 py-2 text-(--solus-text-secondary)">
              <span>Compared with</span>
              <select
                class="h-7 min-w-0 max-w-full rounded-md border border-(--solus-tool-border) bg-transparent px-2 text-(--solus-text-primary) pointer-coarse:h-11"
                aria-label="Compare with"
                value={base === null ? "none" : String(base)}
                onchange={(event) => {
                  const value = event.currentTarget.value;
                  chosenBase = value === "none" ? null : value === "current" ? "current" : Number(value);
                }}
              >
                {#each points.filter((point) => point !== activePick) as point (point)}
                  <option value={String(point)}>{pointLabel(point)}</option>
                {/each}
                <option value="none">Nothing (empty)</option>
              </select>
            </div>
          {/if}

          <div class="min-h-0 flex-1 overflow-auto p-4">
            {#if bodyError}
              <p class="text-(--solus-text-secondary)">Could not load this version: {bodyError}</p>
            {:else if !shown}
              <p class="text-(--solus-text-tertiary)">{activePick === null && revisions ? "This work has no history yet." : "Loading…"}</p>
            {:else if shown.before === shown.after}
              <p class="text-(--solus-text-tertiary)">These versions are the same.</p>
            {:else if type === "diagram" && diagramDiff}
              <div class="flex h-full min-h-[24rem] flex-col gap-3">
                <div class="min-h-0 flex-1 overflow-hidden rounded-xl border border-(--solus-tool-border)">
                  {#await import("../diagram/DiagramPreview.svelte") then preview}
                    <preview.default content={shown.after} {title} marks={diagramDiff} />
                  {/await}
                </div>
                <ul class="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto">
                  {#each diagramDiff.changes as change (`${change.kind}:${change.id}`)}
                    <li class="flex min-w-0 items-center gap-2">
                      <span class="shrink-0 rounded px-1.5 {change.change === 'added' ? 'bg-(--solus-diff-added-bg) text-(--solus-diff-added-text)' : change.change === 'removed' ? 'bg-(--solus-diff-removed-bg) text-(--solus-diff-removed-text)' : 'bg-(--solus-accent-light) text-(--solus-accent)'}">
                        {change.change === "added" ? "Added" : change.change === "removed" ? "Removed" : "Changed"}
                      </span>
                      <span class="shrink-0 text-(--solus-text-tertiary)">{change.kind}</span>
                      <span class="min-w-0 truncate text-(--solus-text-primary)">{change.label}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {:else if type === "artifact"}
              <div class="grid h-full min-h-[24rem] grid-cols-1 gap-3 @min-[48rem]/history:grid-cols-2">
                <figure class="flex min-h-0 flex-col gap-1.5">
                  <figcaption class="text-(--solus-text-tertiary)">{base === null ? "Empty" : pointLabel(base)}</figcaption>
                  <div class="min-h-0 flex-1"><SandboxFrame html={shown.before} fillAvailable expandable={false} /></div>
                </figure>
                <figure class="flex min-h-0 flex-col gap-1.5">
                  <figcaption class="text-(--solus-text-tertiary)">{pointLabel(activePick ?? "current")}</figcaption>
                  <div class="min-h-0 flex-1"><SandboxFrame html={shown.after} fillAvailable expandable={false} /></div>
                </figure>
              </div>
            {:else if sourceView || blocks.length === 0}
              <Diff oldFile={{ name: title, contents: shown.before }} newFile={{ name: title, contents: shown.after }} />
            {:else}
              <div class="flex flex-col gap-2">
                {#each blocks as block, index (index)}
                  <div
                    class="rounded-md border-l-2 px-3 py-0.5 {block.change === 'added' ? 'border-(--solus-diff-added-text) bg-(--solus-diff-added-bg)' : block.change === 'removed' ? 'border-(--solus-diff-removed-text) bg-(--solus-diff-removed-bg) opacity-80' : 'border-transparent'}"
                    data-change={block.change}
                  >
                    {#if block.change !== "same"}
                      <span class="sr-only">{block.change === "added" ? "Added:" : "Removed:"}</span>
                    {/if}
                    <GithubMarkdown source={block.markdown} />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
