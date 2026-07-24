<script lang="ts">
  import { onMount } from "svelte";
  import { FileDiff, File as PierreFile } from "@pierre/diffs";
  import { getSettingsContext } from "../../contexts";
  import { parsePatchMetadata } from "../../lib/diff";
  import { detectMovedBlocks } from "../../lib/diff-moves";
  import { decorateMovedLines } from "../../lib/diff-move-highlight";
  import {
    analyzeDiffNoise,
    collapseFormatOnlyHunks,
    diffNoiseLabel,
  } from "../../lib/diff-noise";
  import { DIFFS_THEME_CSS } from "../../lib/diffTheme";
  import {
    getDiffWorkerPool,
    getDiffThemeName,
    isDiffWorkerPoolReady,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
  } from "../../lib/diff-worker-pool";

  interface Props {
    patch?: string;
    oldFile?: { name: string; contents: string };
    newFile?: { name: string; contents: string };
  }

  let { patch, oldFile, newFile }: Props = $props();

  const theme = getSettingsContext();

  let container: HTMLDivElement | undefined = $state();
  let workerPoolReady = $state(isDiffWorkerPoolReady());
  // Plain `let` — the lifecycle effect below reads + writes both, so making
  // them `$state` would self-trigger an update loop.
  let diffInstance: FileDiff | null = null;
  let fileInstance: PierreFile | null = null;

  const hasFileContents = $derived(!!(oldFile && newFile));
  const mode = $derived<"file-only" | "diff" | "empty">(
    newFile && !oldFile && !patch
      ? "file-only"
      : patch || hasFileContents
        ? "diff"
        : "empty",
  );

  // Bundle every input that requires a fresh FileDiff instance into a single
  // identity. When this changes, we tear down and rebuild — otherwise we just
  // call render() with the new payload.
  const instanceKey = $derived(`${mode}|${hasFileContents}`);
  const fileDiffMeta = $derived(patch ? parsePatchMetadata(patch) : null);
  const analyzedFiles = $derived(fileDiffMeta ? [fileDiffMeta] : []);
  const moveAnalysis = $derived(detectMovedBlocks(analyzedFiles));
  const noiseAnalysis = $derived(
    fileDiffMeta ? analyzeDiffNoise(fileDiffMeta) : null,
  );
  const movedSummary = $derived(
    fileDiffMeta ? moveAnalysis.byFile.get(fileDiffMeta.name) : undefined,
  );
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
    if (!fileDiffMeta) return "";
    const name = fileDiffMeta.name.split("/").pop() ?? fileDiffMeta.name;
    if (noiseAnalysis?.kind) {
      return `${name} · ${diffNoiseLabel(noiseAnalysis)} · unreviewed`;
    }
    if (movedSummary?.allChangesMovedUnchanged) {
      const count = movedSummary.unchangedMovedLines;
      return `${name} · ${count.toLocaleString()} line${count === 1 ? "" : "s"} · moved (unchanged) · collapsed · unreviewed`;
    }
    return "";
  });

  function buildDiffOptions() {
    return {
      theme: getDiffThemeName(theme.isDark),
      themeType: (theme.isDark ? "dark" : "light") as "dark" | "light",
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      overflow: "wrap" as const,
      hunkSeparators: (hasFileContents ? "line-info-basic" : "metadata") as
        | "line-info-basic"
        | "metadata",
      disableFileHeader: true,
      disableErrorHandling: true,
      unsafeCSS: DIFFS_THEME_CSS,
      onPostRender: (node: HTMLElement) => {
        if (!fileDiffMeta) return;
        decorateMovedLines(
          [{ id: fileDiffMeta.name, element: node }],
          moveAnalysis,
          "unified",
        );
      },
    };
  }

  function renderDiff() {
    if (!diffInstance || !container) return;
    const payload = patch
      ? { fileDiff: displayFileDiffMeta, containerWrapper: container }
      : { oldFile, newFile, containerWrapper: container };
    if ("fileDiff" in payload && !payload.fileDiff) return;
    try {
      diffInstance.render(payload as never);
    } catch {
      /* leave the container empty rather than crash. */
    }
  }

  onMount(() => {
    return onDiffWorkerPoolReady(() => {
      workerPoolReady = true;
    });
  });

  // Owns the lifecycle of the underlying FileDiff/File instance.
  // Recreates only when `instanceKey` flips; otherwise keeps the instance
  // and either re-renders (diff) or updates options (file-only).
  $effect(() => {
    if (!container || !workerPoolReady) return;
    if (fileDiffMeta !== previousMetadata) {
      previousMetadata = fileDiffMeta;
      expanded = false;
      formatExpanded = false;
    }
    void instanceKey;
    void autoCollapse;
    void expanded;
    void displayFileDiffMeta;
    void setDiffWorkerPoolTheme(theme.isDark);

    if (mode === "empty") {
      diffInstance?.cleanUp();
      diffInstance = null;
      fileInstance?.cleanUp();
      fileInstance = null;
      return;
    }

    if (mode === "file-only") {
      diffInstance?.cleanUp();
      diffInstance = null;
      const opts = {
        theme: getDiffThemeName(theme.isDark),
        themeType: (theme.isDark ? "dark" : "light") as "dark" | "light",
        overflow: "wrap" as const,
        disableFileHeader: true,
        unsafeCSS: DIFFS_THEME_CSS,
      };
      fileInstance ??= new PierreFile(opts, getDiffWorkerPool());
      fileInstance.setOptions(opts);
      fileInstance.render({ file: newFile!, containerWrapper: container });
      return;
    }

    if (autoCollapse && !expanded) {
      diffInstance?.cleanUp();
      diffInstance = null;
      return;
    }

    fileInstance?.cleanUp();
    fileInstance = null;
    diffInstance?.cleanUp();
    diffInstance = new FileDiff(buildDiffOptions(), getDiffWorkerPool());
    renderDiff();
  });

  // Re-render when content changes without flipping `instanceKey`.
  $effect(() => {
    if (mode !== "diff" || !diffInstance) return;
    void patch;
    void oldFile?.contents;
    void newFile?.contents;
    renderDiff();
  });

  $effect(() => {
    const themeType = theme.isDark ? "dark" : "light";
    void setDiffWorkerPoolTheme(theme.isDark);
    diffInstance?.setThemeType(themeType);
    fileInstance?.setThemeType(themeType);
  });

  $effect(() => () => {
    diffInstance?.cleanUp();
    diffInstance = null;
    fileInstance?.cleanUp();
    fileInstance = null;
  });
</script>

<button
  type="button"
  class:hidden={!autoCollapse || expanded}
  class="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-[0.6875rem] text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96]"
  aria-label={`Expand ${collapsedSummary}`}
  onclick={() => (expanded = true)}
>
  <span class="inline-block size-1.5 shrink-0 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current"></span>
  <span class="min-w-0 flex-1 truncate">{collapsedSummary}</span>
</button>
<button
  type="button"
  class:hidden={!formatOnlyCollapsed || (autoCollapse && !expanded)}
  class="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-[0.6875rem] text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96]"
  aria-label={`Expand ${formatSummary}`}
  onclick={() => (formatExpanded = true)}
>
  <span class="inline-block size-1.5 shrink-0 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current"></span>
  <span class="min-w-0 flex-1 truncate">{formatSummary}</span>
</button>
<div
  bind:this={container}
  class:hidden={autoCollapse && !expanded}
  class="pierre-diff-host overflow-hidden"
></div>

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
</style>
