<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { untrack } from "svelte";
  import { Dialog } from "bits-ui";
  import { RotateCcw as RestoreIcon, X as XIcon } from "@lucide/svelte";
  import type { WorkType } from "@solus/contracts/types";
  import { getSurfaceContext, presenceStore } from "../../contexts";
  import { Button } from "../ui/button";
  import * as Select from "../ui/select";
  import { Switch } from "../ui/switch";
  import Kbd from "../ui/Kbd.svelte";
  import Diff from "../diff/Diff.svelte";
  import GithubMarkdown from "../github-markdown/GithubMarkdown.svelte";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import { attributionName } from "../presence/lib/actor-name";
  import { relativeTime } from "../../lib/relative-time";
  import { toasts } from "../../lib/toasts";
  import { getWorkPaneContext } from "./lib/work-pane-context";
  import {
    comparisonBase,
    historyPoints,
    historyRows,
    markdownBlockDiff,
    revisionReasonLabel,
    type HistoryPoint,
  } from "./lib/work-history";

  import { workSourceDiff } from "./lib/work-source-diff";
  import { ArtifactChangeMarks, withChangeMarks } from "./lib/artifact-change-marks";

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
  const currentBody = $derived(currentContent());
  const savedContent = $derived(session.worksStore.savedWork(workId)?.content);
  const hasDraftChanges = $derived(savedContent !== undefined && currentBody !== savedContent);
  const points = $derived(historyPoints(rows, currentHash, hasDraftChanges));
  const loadError = $derived(history.errors.get(workId) ?? null);

  let picked = $state<HistoryPoint | null>(null);
  /** Undefined follows the picked point; null means an empty body. */
  let chosenBase = $state<HistoryPoint | null | undefined>(undefined);
  let sourceView = $state(false);
  let restoring = $state(false);
  let diffStyle = $state<"unified" | "split">("unified");
  let highlightChanges = $state(true);
  let retry = $state(0);

  $effect(() => {
    if (!open) return;
    picked = null;
    chosenBase = initialBase ?? undefined;
    void history.load(workId);
  });

  // Once the list arrives, pick the requested point or the newest one.
  const activePick = $derived<HistoryPoint | null>(
    picked ?? (initialPick !== null && initialPick !== "current" && rowById.has(initialPick) ? initialPick : (points[0] ?? null)),
  );
  const base = $derived(comparisonBase(points, activePick, chosenBase));

  let bodies = $state<{ key: string; current: string | null; before: string; after: string } | null>(null);
  let bodyError = $state<string | null>(null);
  const comparisonKey = $derived(activePick === null ? null : `${workId}:${base ?? "none"}→${activePick}`);

  const comparisonCurrent = $derived(base === "current" || activePick === "current" ? currentBody : null);

  async function bodyOf(point: HistoryPoint | null, current: string | null): Promise<string> {
    if (point === null) return "";
    if (point === "current") return current ?? "";
    return history.body(workId, point);
  }

  $effect(() => {
    const key = comparisonKey;
    const from = base;
    const to = activePick;
    const current = comparisonCurrent;
    void retry;
    if (!open || key === null) return;
    bodyError = null;
    let cancelled = false;
    void Promise.all([bodyOf(from, current), bodyOf(to, current)]).then(
      ([before, after]) => {
        if (!cancelled) bodies = { key, current, before, after };
      },
      (error: Error) => {
        if (!cancelled) bodyError = error.message;
      },
    );
    return () => { cancelled = true; };
  });

  const shown = $derived(bodies && bodies.key === comparisonKey && bodies.current === comparisonCurrent ? bodies : null);
  const blocks = $derived(shown && (type === "doc" || type === "slides") && !sourceView ? markdownBlockDiff(shown.before, shown.after) : []);
  const sourceDiff = $derived(shown && sourceView ? workSourceDiff(type, shown.before, shown.after) : null);

  // Names this dialog's frames, so a render from another dialog is not heard.
  const markNonce = Math.random().toString(36).slice(2);
  const markChannel = $derived(comparisonKey === null ? null : `${markNonce}:${comparisonKey}`);
  const artifactFrames = $derived(
    shown && type === "artifact" && !sourceView && markChannel !== null
      ? { before: withChangeMarks(shown.before, markChannel, "before"), after: withChangeMarks(shown.after, markChannel, "after") }
      : null,
  );
  let changeMarks = $state.raw<ArtifactChangeMarks | null>(null);

  // The frames report their words over postMessage; nothing else can listen for them.
  $effect(() => {
    const channel = markChannel;
    if (!open || artifactFrames === null || channel === null) return;
    const marks = new ArtifactChangeMarks(channel, untrack(() => highlightChanges));
    changeMarks = marks;
    const onMessage = (event: MessageEvent) => marks.receive(event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  $effect(() => {
    changeMarks?.setEnabled(highlightChanges);
  });

  function toggleHighlightShortcut(event: KeyboardEvent) {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.code !== "KeyH") return;
    event.preventDefault();
    highlightChanges = !highlightChanges;
  }

  function pointTitle(point: HistoryPoint): string {
    if (point === "current") return hasDraftChanges ? "Unsaved edits" : "Current version";
    const row = rowById.get(point);
    return row ? revisionReasonLabel(row.reason) : `Version ${point}`;
  }

  function pointTime(point: HistoryPoint): string | null {
    const row = point === "current" ? null : rowById.get(point);
    return row ? relativeTime(Date.parse(row.capturedAt)) : null;
  }

  function pointLabel(point: HistoryPoint): string {
    if (point === "current") return hasDraftChanges ? "Current version (unsaved edits)" : "Current version";
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
    chosenBase = undefined;
    document.querySelector<HTMLElement>(`[data-history-point="${next}"]`)?.focus();
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => open });
</script>


<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop" />
    <Dialog.Content
      class="@container/history text-workspace-chrome fixed top-1/2 left-1/2 z-50 flex h-[min(64rem,calc(100dvh-2rem))] w-[min(112rem,calc(100vw-2rem))] -translate-1/2 flex-col overflow-hidden rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) shadow-(--solus-popover-shadow)"
      data-testid="work-history"
      onkeydown={toggleHighlightShortcut}
    >
      <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-3 pl-5 text-(--solus-text-secondary)">
        <div class="flex min-w-0 items-baseline gap-2">
          <Dialog.Title class="shrink-0 font-medium text-(--solus-text-primary)">Version history</Dialog.Title>
          <Dialog.Description class="min-w-0 truncate text-(--solus-text-tertiary)">{title}</Dialog.Description>
        </div>
        {#if activePick !== null}
          <div class="flex min-w-0 items-center gap-2">
            <span>Compared with</span>
            <Select.Root
              type="single"
              value={base === null ? "none" : String(base)}
              onValueChange={(value) => {
                chosenBase = value === "none" ? null : value === "current" ? "current" : Number(value);
              }}
            >
              <Select.Trigger size="sm" aria-label="Compare with" class="max-w-full min-w-0 text-workspace-chrome text-(--solus-text-primary) pointer-coarse:h-11">
                <span class="truncate">{base === null ? "Nothing (empty)" : pointLabel(base)}</span>
              </Select.Trigger>
              <Select.Content align="start" class="max-h-72">
                {#each points.filter((point) => point !== activePick) as point (point)}
                  <Select.Item value={String(point)} label={pointLabel(point)} class="text-workspace-chrome" />
                {/each}
                <Select.Item value="none" label="Nothing (empty)" class="text-workspace-chrome" />
              </Select.Content>
            </Select.Root>
            {#if sourceView}
              <Select.Root type="single" value={diffStyle} onValueChange={(value) => (diffStyle = value === "split" ? "split" : "unified")}>
                <Select.Trigger size="sm" aria-label="Diff layout" class="text-workspace-chrome text-(--solus-text-primary) pointer-coarse:h-11">
                  {diffStyle === "split" ? "Side by side" : "Unified"}
                </Select.Trigger>
                <Select.Content align="start">
                  <Select.Item value="unified" label="Unified" class="text-workspace-chrome" />
                  <Select.Item value="split" label="Side by side" class="text-workspace-chrome" />
                </Select.Content>
              </Select.Root>
            {/if}
          </div>
        {/if}
        <div class="ml-auto flex shrink-0 items-center gap-3">
          {#if activePick !== null}
            {#if sourceView && sourceDiff && !sourceDiff.error}
              <span class="flex gap-2 tabular-nums" aria-label={`${sourceDiff.additions} lines added, ${sourceDiff.deletions} lines removed`}>
                <span class="text-(--solus-diff-added-text)">+{sourceDiff.additions}</span>
                <span class="text-(--solus-diff-removed-text)">−{sourceDiff.deletions}</span>
              </span>
            {/if}
            <label class="flex cursor-pointer items-center gap-2 text-(--solus-text-primary)" title="Highlight changes (⌥H)">
              <Switch size="sm" bind:checked={highlightChanges} aria-label="Highlight changes" />
              <span>Highlight changes</span>
              <Kbd variant="hint" class="pointer-coarse:hidden">⌥H</Kbd>
            </label>
          {/if}
          <div class="flex items-center rounded-lg bg-(--solus-surface-hover) p-0.5" role="radiogroup" aria-label="View">
            {#each [{ source: false, label: "Preview" }, { source: true, label: "Source" }] as option (option.label)}
              <button
                type="button"
                role="radio"
                aria-checked={sourceView === option.source}
                class="h-7 rounded-md px-3 font-medium transition-colors pointer-coarse:h-10 {sourceView === option.source ? 'bg-(--solus-container-bg) text-(--solus-text-primary) shadow-xs' : 'text-(--solus-text-secondary) hover:text-(--solus-text-primary)'}"
                onclick={() => (sourceView = option.source)}
              >{option.label}</button>
            {/each}
          </div>
          {#if canRestore}
            <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" data-testid="restore-version" disabled={restoring} onclick={() => void restore()}>
              <RestoreIcon size={14} />
              {restoring ? "Restoring…" : "Restore this version"}
            </Button>
          {/if}
          <Dialog.Close>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" class="pointer-coarse:size-11" aria-label="Close history"><XIcon size={16} /></Button>
            {/snippet}
          </Dialog.Close>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col @min-[48rem]/history:flex-row">
        <div class="flex max-h-[30%] shrink-0 flex-col @min-[48rem]/history:max-h-none @min-[48rem]/history:w-72">
          <div class="flex shrink-0 items-center justify-between px-5 pt-2 pb-1.5 text-(--solus-text-tertiary)">
            <span class="font-medium">Versions</span>
            {#if points.length > 0}<span class="tabular-nums">{points.length}</span>{/if}
          </div>
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <ol class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3" aria-label="Versions" onkeydown={moveSelection}>
            {#if !revisions && !loadError}
              <li class="px-2.5 py-2 text-(--solus-text-tertiary)">Loading history…</li>
            {:else if loadError && !revisions}
              <li class="flex items-center justify-between gap-2 px-2.5 py-2 text-(--solus-text-secondary)">
                <span class="min-w-0">Could not load the history.</span>
                <Button variant="outline" size="xs" onclick={() => void history.load(workId)}>Retry</Button>
              </li>
            {/if}
            {#each points as point (point)}
              {@const author = authorOf(point)}
              {@const time = pointTime(point)}
              {@const isPicked = point === activePick}
              <li>
                <button
                  type="button"
                  data-history-point={point}
                  class="relative flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:min-h-11 {isPicked ? 'bg-(--solus-surface-hover)' : ''}"
                  aria-current={isPicked}
                  onclick={() => { picked = point; chosenBase = undefined; }}
                >
                  <span class="mt-1.5 size-2 shrink-0 rounded-full {isPicked ? 'bg-(--solus-accent)' : point === 'current' ? 'bg-(--solus-text-secondary)' : 'bg-(--solus-tool-border)'}" aria-hidden="true"></span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex min-w-0 items-baseline justify-between gap-2">
                      <span class="truncate font-medium {isPicked ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}">{pointTitle(point)}</span>
                      {#if time}<span class="shrink-0 text-(--solus-text-tertiary)">{time}</span>{/if}
                    </span>
                    {#if author}
                      <span class="truncate text-(--solus-text-tertiary)">by {author}</span>
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ol>
        </div>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">

          <div class="min-h-0 flex-1 overflow-auto px-5 pt-2 pb-5">
            {#if bodyError}
              <p class="text-(--solus-text-secondary)">Could not load this version: {bodyError}</p>
              <Button variant="outline" size="xs" onclick={() => retry++}>Retry</Button>
            {:else if !shown}
              <p class="text-(--solus-text-tertiary)">{activePick === null && revisions ? "This work has no history yet." : "Loading…"}</p>
            {:else if shown.before === shown.after}
              <p class="text-(--solus-text-tertiary)">These versions are the same.</p>
            {:else if sourceView}
              {#if sourceDiff?.error}
                <p class="text-(--solus-text-secondary)">Could not compare the source: {sourceDiff.error}</p>
              {:else if sourceDiff?.file}
                <Diff fileDiff={sourceDiff.file} {diffStyle} tokenHighlight={highlightChanges} collapseNoise={false} />
              {/if}
            {:else if artifactFrames}
              <div class="grid h-full min-h-[28rem] grid-cols-1 gap-4 @min-[48rem]/history:grid-cols-2">
                {#each [{ side: "before", point: base, html: artifactFrames.before }, { side: "after", point: activePick, html: artifactFrames.after }] as frame (frame.side)}
                  <figure class="flex min-h-0 min-w-0 flex-col gap-2">
                    <figcaption class="flex shrink-0 items-center gap-2 px-1">
                      <span class="size-2 shrink-0 rounded-full {frame.side === 'before' ? 'bg-(--solus-diff-removed-text)' : 'bg-(--solus-diff-added-text)'}" aria-hidden="true"></span>
                      <span class="shrink-0 font-medium text-(--solus-text-primary)">{frame.side === "before" ? "Before" : "After"}</span>
                      <span class="min-w-0 truncate text-(--solus-text-tertiary)">{frame.point === null ? "Empty" : pointLabel(frame.point)}</span>
                    </figcaption>
                    <div class="flex min-h-0 flex-1 flex-col overflow-auto rounded-2xl bg-(--solus-surface-hover)/50 p-5">
                      <SandboxFrame html={frame.html} heightKey={frame.side === "before" ? shown.before : shown.after} fillAvailable expandable={false} />
                    </div>
                  </figure>
                {/each}
              </div>
            {:else if blocks.length === 0}
              <Diff oldFile={{ name: title, contents: shown.before }} newFile={{ name: title, contents: shown.after }} tokenHighlight={highlightChanges} />
            {:else}
              <div class="mx-auto flex max-w-3xl flex-col gap-2">
                {#each blocks as block, index (index)}
                  {#if highlightChanges || block.change !== "removed"}
                    <div
                      class="prose rounded-md border-l-2 px-3 py-0.5 {highlightChanges && block.change === 'added' ? 'border-(--solus-diff-added-text) bg-(--solus-diff-added-bg)' : highlightChanges && block.change === 'removed' ? 'border-(--solus-diff-removed-text) bg-(--solus-diff-removed-bg) opacity-80' : 'border-transparent'}"
                      data-change={block.change}
                    >
                      {#if highlightChanges && block.change !== "same"}
                        <span class="sr-only">{block.change === "added" ? "Added:" : "Removed:"}</span>
                      {/if}
                      <GithubMarkdown source={block.markdown} />
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
