<script lang="ts">
  import { onMount } from "svelte";
  import { FileDiff, File as PierreFile } from "@pierre/diffs";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { parsePatchMetadata } from "../../lib/diff";
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
    };
  }

  function renderDiff() {
    if (!diffInstance || !container) return;
    const payload = patch
      ? { fileDiff: parsePatchMetadata(patch), containerWrapper: container }
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
    void instanceKey;
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

<div bind:this={container} class="pierre-diff-host overflow-hidden"></div>

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
