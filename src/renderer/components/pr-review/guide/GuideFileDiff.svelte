<script lang="ts">
  import { mount, unmount, onMount } from "svelte";
  import {
    FileDiff,
    type DiffLineAnnotation,
    type SelectedLineRange,
    type SelectionSide,
  } from "@pierre/diffs";
  import type { DiffComment } from "../../../../shared/types";
  import { getSettingsContext } from "../../../contexts/settings.context.svelte";
  import { parsePatchMetadata } from "../../../lib/diff";
  import {
    detectMovedBlocks,
    type DiffMoveAnalysis,
  } from "../../../lib/diff-moves";
  import { decorateMovedLines } from "../../../lib/diff-move-highlight";
  import {
    analyzeDiffNoise,
    collapseFormatOnlyHunks,
    diffNoiseLabel,
  } from "../../../lib/diff-noise";
  import { DIFFS_THEME_CSS } from "../../../lib/diffTheme";
  import {
    getDiffWorkerPool,
    getDiffThemeName,
    isDiffWorkerPoolReady,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
  } from "../../../lib/diff-worker-pool";
  import DiffCommentForm from "../../diff/DiffCommentForm.svelte";
  import DiffInlineComment from "../../diff/DiffInlineComment.svelte";
  import { Button } from "../../ui/button";
  import { InlineCommentDraft } from "../../../contexts/diff-comment-draft.store.svelte";
  import type { GuideDiffCommentSave } from "./lib/guide-data";
  import { profilePrReviewWork } from "../lib/pr-review-profiler";

  type AnnotationMeta =
    | { kind: "comment"; comment: DiffComment }
    | { kind: "draft" };

  // Draft metadata is a stable reference so an unchanged draft annotation hits the
  // FileDiff annotation cache and the form isn't re-adopted on every resync.
  const DRAFT_META: AnnotationMeta = { kind: "draft" };

  // A single changed file in the review guide, rendered as a content-height diff.
  // When `onSaveComment` is supplied the card becomes comment-capable (hover
  // gutter "+", range selection, inline form + saved comments), reusing the same
  // review-draft store the Diff tab writes to. Without it the card is read-only,
  // matching Diff.svelte.
  let {
    patch,
    filePath,
    comments = [],
    onSaveComment,
    onDeleteComment,
    moveAnalysis: sharedMoveAnalysis,
  }: {
    patch: string;
    filePath: string;
    comments?: DiffComment[];
    onSaveComment?: (comment: GuideDiffCommentSave) => void;
    onDeleteComment?: (id: string) => void;
    moveAnalysis?: DiffMoveAnalysis;
  } = $props();

  const theme = getSettingsContext();
  const commentsEnabled = $derived(!!onSaveComment);

  let container: HTMLDivElement | undefined = $state();
  let draftFormWrapper: HTMLDivElement | null = $state(null);
  let workerPoolReady = $state(isDiffWorkerPoolReady());

  // Plain `let` — the lifecycle effect reads + writes this, so `$state` would
  // self-trigger an update loop (mirrors Diff.svelte).
  let fileInstance: FileDiff<AnnotationMeta> | null = null;
  let mountedComments: ReturnType<typeof mount>[] = [];

  // Ephemeral per-card comment state — drafts live only until saved (no cross-tab
  // persistence; the saved drafts are the shared store, threaded in via props).
  // This card is a single file, so the draft's filePath is left unused.
  const draft = new InlineCommentDraft();

  // parsePatchMetadata caches by patch string, so this returns a stable reference
  // across annotation-only re-renders (keeps FileDiff from treating it as a new diff).
  const fileDiffMeta = $derived(
    profilePrReviewWork(
      "patch-parse",
      () => parsePatchMetadata(patch),
      { filePath, patchCharacters: patch.length },
    ),
  );
  const analyzedFiles = $derived(fileDiffMeta ? [fileDiffMeta] : []);
  const localMoveAnalysis = $derived(
    profilePrReviewWork(
      "moved-block-analysis",
      () => detectMovedBlocks(analyzedFiles),
      { filePath },
    ),
  );
  const moveAnalysis = $derived(sharedMoveAnalysis ?? localMoveAnalysis);
  const noiseAnalysis = $derived(
    fileDiffMeta
      ? profilePrReviewWork(
          "diff-noise-analysis",
          () => analyzeDiffNoise(fileDiffMeta),
          { filePath },
        )
      : null,
  );
  const movedSummary = $derived(moveAnalysis.byFile.get(filePath));
  const autoCollapse = $derived(
    noiseAnalysis?.autoCollapse === true ||
      movedSummary?.allChangesMovedUnchanged === true,
  );
  let expanded = $state(false);
  let formatExpanded = $state(false);
  let previousMetadata = fileDiffMeta;
  const formatOnlyCollapsed = $derived(
    !!fileDiffMeta && !formatExpanded &&
      !(autoCollapse && expanded) &&
      (noiseAnalysis?.formatOnlyHunks.length ?? 0) > 0 &&
      (noiseAnalysis?.formatOnlyHunks.length ?? 0) < fileDiffMeta.hunks.length,
  );
  const displayFileDiffMeta = $derived(
    fileDiffMeta && formatOnlyCollapsed
      ? collapseFormatOnlyHunks(fileDiffMeta)
      : fileDiffMeta,
  );
  const formatSummary = $derived(
    noiseAnalysis
      ? `${noiseAnalysis.formatOnlyLineCount.toLocaleString()} line${noiseAnalysis.formatOnlyLineCount === 1 ? "" : "s"} · format-only · collapsed · unreviewed`
      : "",
  );

  const collapsedSummary = $derived.by(() => {
    if (noiseAnalysis?.kind) {
      return `${filePath.split("/").pop() ?? filePath} · ${diffNoiseLabel(noiseAnalysis)} · unreviewed`;
    }
    if (movedSummary?.allChangesMovedUnchanged) {
      const count = movedSummary.unchangedMovedLines;
      return `${filePath.split("/").pop() ?? filePath} · ${count.toLocaleString()} line${count === 1 ? "" : "s"} · moved (unchanged) · collapsed · unreviewed`;
    }
    return "";
  });

  function mapSide(side: SelectionSide | undefined): "old" | "new" {
    return side === "deletions" ? "old" : "new";
  }

  function annotationSide(side: "old" | "new"): SelectionSide {
    return side === "old" ? "deletions" : "additions";
  }

  // Existing comments (minus the one being edited, which the draft form replaces)
  // plus a draft annotation at the selected range while commenting.
  function buildAnnotations(): DiffLineAnnotation<AnnotationMeta>[] {
    if (!commentsEnabled) return [];
    const out = comments
      .filter((c) => c.id !== draft.editingCommentId)
      .map(
        (c) =>
          ({
            side: annotationSide(c.side),
            lineNumber: c.endLine,
            metadata: { kind: "comment", comment: c } as AnnotationMeta,
          }) as DiffLineAnnotation<AnnotationMeta>,
      );
    if (draft.range) {
      out.push({
        side: annotationSide(draft.range.side),
        lineNumber: draft.range.endLine,
        metadata: DRAFT_META,
      } as DiffLineAnnotation<AnnotationMeta>);
    }
    return out;
  }

  function unmountComments() {
    mountedComments.forEach((i) => unmount(i));
    mountedComments = [];
  }

  function renderDiff() {
    if (!fileInstance || !container || !displayFileDiffMeta) return;
    // renderAnnotation re-mounts comment components, so drop the previous
    // instances first (the same unmount-then-resync order DiffStream uses).
    unmountComments();
    try {
      profilePrReviewWork(
        "diff-render",
        () => fileInstance?.render({
          fileDiff: displayFileDiffMeta,
          containerWrapper: container,
          lineAnnotations: buildAnnotations(),
        }),
        { filePath, patchCharacters: patch.length },
      );
    } catch {
      /* leave the container empty rather than crash. */
    }
  }

  function buildDiffOptions() {
    const base = {
      theme: getDiffThemeName(theme.isDark),
      themeType: (theme.isDark ? "dark" : "light") as "dark" | "light",
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      overflow: "wrap" as const,
      // "simple" over "metadata": the guide's concern-scoped cards often hold
      // several disjoint hunks, and a @@-metadata rule at every boundary reads
      // as line noise in a walkthrough meant for reading.
      hunkSeparators: "simple" as const,
      disableFileHeader: true,
      disableErrorHandling: true,
      unsafeCSS: DIFFS_THEME_CSS,
      onPostRender: (node: HTMLElement) => {
        decorateMovedLines(
          [{ id: filePath, element: node }],
          moveAnalysis,
          "unified",
        );
      },
    };
    if (!commentsEnabled) return base;
    return {
      ...base,
      lineHoverHighlight: "number" as const,
      enableLineSelection: true,
      enableGutterUtility: true,
      renderAnnotation: (annotation: DiffLineAnnotation<AnnotationMeta>) => {
        if (annotation.metadata?.kind === "draft") {
          return draftFormWrapper ?? document.createElement("div");
        }
        if (annotation.metadata?.kind !== "comment") return undefined;
        const target = document.createElement("div");
        const instance = mount(DiffInlineComment, {
          target,
          props: {
            comment: annotation.metadata.comment,
            variant: "minimal" as const,
            onEdit: handleEditComment,
            onDelete: handleDeleteComment,
          },
        });
        mountedComments.push(instance);
        return target;
      },
      onGutterUtilityClick: (range: SelectedLineRange) => {
        openDraftForRange(range.start, range.end, mapSide(range.side));
      },
      onLineSelected: (range: SelectedLineRange | null) => {
        if (range)
          openDraftForRange(range.start, range.end, mapSide(range.side));
      },
    };
  }

  // Both selection gestures (gutter "+" and dragging line numbers) open the
  // comment form. Adjusting the range of an in-progress new comment keeps any
  // text already typed; starting from an edit resets it.
  function openDraftForRange(start: number, end: number, side: "old" | "new") {
    const sameDraft = draft.range !== null && draft.editingCommentId === null;
    draft.range = {
      startLine: Math.min(start, end),
      endLine: Math.max(start, end),
      side,
    };
    if (!sameDraft) {
      draft.editingCommentId = null;
      draft.value = "";
    }
  }

  function resetDraft() {
    draft.clear();
    // Clear pierre's internal selection too; without this, the InteractionManager
    // still holds the selected range and can re-fire onLineSelected / placeUtility
    // on the next re-render, which calls openDraftForRange and re-opens the form.
    fileInstance?.setSelectedLines(null);
  }

  function handleDraftSave(text: string) {
    if (!onSaveComment || !draft.range) return;
    // Snapshot the draft, then dismiss it BEFORE saving. The saved comment
    // renders an annotation at the same line, so a lingering draft would stack a
    // second box beneath it; clearing first also keeps the form from surviving
    // if onSaveComment throws.
    const save: GuideDiffCommentSave = {
      id: draft.editingCommentId ?? undefined,
      filePath,
      startLine: draft.range.startLine,
      endLine: draft.range.endLine,
      side: draft.range.side,
      selectedCode: "",
      comment: text,
    };
    resetDraft();
    onSaveComment(save);
  }

  function handleEditComment(c: DiffComment) {
    draft.editingCommentId = c.id;
    draft.range = {
      startLine: c.startLine,
      endLine: c.endLine,
      side: c.side,
    };
    draft.value = c.comment;
  }

  function handleDeleteComment(id: string) {
    onDeleteComment?.(id);
  }

  onMount(() => {
    return onDiffWorkerPoolReady(() => {
      workerPoolReady = true;
    });
  });

  // Owns the FileDiff lifecycle and re-renders on patch + annotation-state change.
  // Theme is pushed through the lighter setThemeType effect below instead.
  $effect(() => {
    if (fileDiffMeta !== previousMetadata) {
      previousMetadata = fileDiffMeta;
      expanded = false;
      formatExpanded = false;
    }
    if (!container || !workerPoolReady) return;
    void fileDiffMeta;
    void displayFileDiffMeta;
    void comments;
    void draft.range;
    void draft.editingCommentId;

    if (!fileDiffMeta || (autoCollapse && !expanded)) {
      unmountComments();
      fileInstance?.cleanUp();
      fileInstance = null;
      return;
    }

    fileInstance ??= new FileDiff<AnnotationMeta>(
      buildDiffOptions(),
      getDiffWorkerPool(),
    );
    renderDiff();
  });

  $effect(() => {
    const themeType = theme.isDark ? "dark" : "light";
    void setDiffWorkerPoolTheme(theme.isDark);
    fileInstance?.setThemeType(themeType);
  });

  $effect(() => () => {
    unmountComments();
    fileInstance?.cleanUp();
    fileInstance = null;
  });
</script>

<Button
  type="button"
  variant="ghost"
  class="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-[0.6875rem] text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] {autoCollapse && !expanded ? '' : 'hidden'}"
  aria-label={`Expand ${collapsedSummary}`}
  onclick={() => (expanded = true)}
>
  <span class="inline-block size-1.5 shrink-0 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current"></span>
  <span class="min-w-0 flex-1 truncate">{collapsedSummary}</span>
</Button>
<Button
  type="button"
  variant="ghost"
  class="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-[0.6875rem] text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] {formatOnlyCollapsed && (!autoCollapse || expanded) ? '' : 'hidden'}"
  aria-label={`Expand ${formatSummary}`}
  onclick={() => (formatExpanded = true)}
>
  <span class="inline-block size-1.5 shrink-0 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current"></span>
  <span class="min-w-0 flex-1 truncate">{formatSummary}</span>
</Button>
<div
  bind:this={container}
  class:hidden={autoCollapse && !expanded}
  class="pierre-diff-host overflow-hidden"
></div>

<!--
  Draft form portal — Svelte owns this element, but @pierre/diffs adopts (relocates)
  it into the annotation slot at the selected line when a draft annotation is active.
  While idle, display:none keeps it invisible wherever it currently sits.
-->
<div bind:this={draftFormWrapper} class="solus-inline-draft-portal">
  {#if draft.range}
    <DiffCommentForm
      onSave={handleDraftSave}
      onCancel={resetDraft}
      rangeLabel={draft.rangeLabel}
      initialValue={draft.value}
      onFormValueChange={(v) => (draft.value = v)}
    />
  {/if}
</div>

<style>
  .pierre-diff-host {
    /* Drive the diff component's code font off our rem-based token. Set in the
       light DOM so it inherits across the shadow boundary and updates live with
       the "Code font size" setting and screen scale. */
    --diffs-font-family: var(--solus-code-font-family);
    --diffs-font-size: var(--solus-code-font-size, 0.75rem);
    --diffs-line-height: calc(var(--solus-code-font-size, 0.75rem) * 1.6);
  }
  .pierre-diff-host :global(diffs-component) {
    display: block;
  }

  :global(.solus-inline-draft-portal) {
    display: none;
  }

  :global([data-annotation-slot] > .solus-inline-draft-portal) {
    display: block;
    padding: 0.5rem 0.75rem 0.625rem;
  }
</style>
