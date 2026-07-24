<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { File as PierreFile, type FileContents, type FileOptions } from "@pierre/diffs";
  import { Editor } from "@pierre/diffs/editor";
  import type { IpcContext } from "../../../shared/types";
  import { DIFFS_THEME_CSS } from "../../lib/diffTheme";
  import {
    getDiffThemeName,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
  } from "../../lib/diff-worker-pool";
  import { toasts } from "../../contexts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";

  export type FileSaveState =
    | "idle"
    | "dirty"
    | "saving"
    | "saved"
    | "error"
    | "conflict";

  const LINKED_LINE_CSS = `
    [data-solus-linked-line] {
      --diffs-line-bg: var(--solus-diff-selection-bg) !important;
      background-color: var(--solus-diff-selection-bg) !important;
    }
    [data-column-number][data-solus-linked-line] {
      color: var(--solus-accent) !important;
      box-shadow: inset 2px 0 var(--solus-accent);
    }
  `;

  interface Props {
    api?: typeof window.solus;
    ctx: IpcContext;
    cwd: string;
    filePath: string;
    displayPath: string;
    contents: string;
    isDark: boolean;
    line?: number;
    onSaveStateChange?: (state: FileSaveState) => void;
  }

  let {
    api = window.solus,
    ctx,
    cwd,
    filePath,
    displayPath,
    contents,
    isDark,
    line,
    onSaveStateChange,
  }: Props = $props();

  let rootEl: HTMLDivElement | null = $state(null);
  let fileInstance: PierreFile | null = null;
  let editor: Editor<undefined> | null = null;
  let detachEditor: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedContents = "";
  let latestContents = "";
  let saveGeneration = 0;
  let linkedLineRequestKey = "";
  let linkedLineDismissed = false;

  useScope("file-editor");
  useKeybinding("file-editor.save", () => {
    void flushSave();
  });

  function setSaveState(state: FileSaveState) {
    onSaveStateChange?.(state);
  }

  function syncContainerBackground() {
    const container = rootEl?.firstElementChild;
    if (container instanceof HTMLElement) {
      container.style.backgroundColor = "var(--solus-container-bg)";
    }
  }

  function buildOptions(): FileOptions<undefined> {
    return {
      theme: getDiffThemeName(isDark),
      themeType: isDark ? "dark" : "light",
      useTokenTransformer: true,
      lineHoverHighlight: "disabled",
      overflow: "wrap",
      disableFileHeader: true,
      disableErrorHandling: true,
      enableGutterUtility: false,
      enableLineSelection: false,
      unsafeCSS: `${DIFFS_THEME_CSS}\n${LINKED_LINE_CSS}`,
      onPostRender: (_container, _instance, phase) => {
        if (phase !== "unmount") requestAnimationFrame(markLinkedLine);
      },
    };
  }

  function contentVersion(value: string): number {
    let hash = value.length;
    const step = Math.max(1, Math.floor(value.length / 128));
    for (let i = 0; i < value.length; i += step) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function buildFile(value = latestContents): FileContents {
    return {
      name: displayPath || filePath,
      contents: value,
      cacheKey: `${filePath}:${contentVersion(value)}`,
    };
  }

  function syncLinkedLineRequest() {
    const nextKey = line ? `${filePath}:${line}` : "";
    if (nextKey === linkedLineRequestKey) return;
    linkedLineRequestKey = nextKey;
    linkedLineDismissed = false;
  }

  function clearLinkedLineMarker(shadowRoot: ShadowRoot) {
    for (const element of shadowRoot.querySelectorAll("[data-solus-linked-line]")) {
      element.removeAttribute("data-solus-linked-line");
    }
  }

  function markLinkedLine(): Element | null {
    syncLinkedLineRequest();
    const shadowRoot = rootEl?.firstElementChild?.shadowRoot;
    if (!shadowRoot) return null;

    clearLinkedLineMarker(shadowRoot);
    if (!line || linkedLineDismissed) return null;

    const lineElement = shadowRoot.querySelector(`[data-line="${line}"]`);
    const gutterElement = shadowRoot.querySelector(`[data-column-number="${line}"]`);
    lineElement?.setAttribute("data-solus-linked-line", "");
    gutterElement?.setAttribute("data-solus-linked-line", "");
    return lineElement;
  }

  function dismissLinkedLine() {
    syncLinkedLineRequest();
    linkedLineDismissed = true;
    const shadowRoot = rootEl?.firstElementChild?.shadowRoot;
    if (shadowRoot) clearLinkedLineMarker(shadowRoot);
  }

  function revealLinkedLine() {
    if (!line || !rootEl) {
      markLinkedLine();
      return;
    }
    requestAnimationFrame(() => {
      const lineElement = markLinkedLine();
      lineElement?.scrollIntoView({ block: "center" });
    });
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const contentsToSave = latestContents;
    if (contentsToSave === lastSavedContents) return;

    const generation = ++saveGeneration;
    setSaveState("saving");
    const result = await api.writeFile(ctx, {
      path: filePath,
      cwd,
      contents: contentsToSave,
      expectedContents: lastSavedContents,
    });
    if (generation !== saveGeneration) return;
    if (result.ok) {
      lastSavedContents = contentsToSave;
      setSaveState("saved");
    } else if (result.conflict) {
      setSaveState("conflict");
      toasts.error(`${displayPath || filePath} changed on disk. Reload before saving.`);
    } else {
      setSaveState("error");
      toasts.error(`Save failed: ${displayPath || filePath} — ${result.error}`);
    }
  }

  function scheduleSave(nextContents: string) {
    latestContents = nextContents;
    setSaveState("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushSave();
    }, 500);
  }

  onMount(() => {
    if (!rootEl) return;
    let disposed = false;
    rootEl.addEventListener("pointerdown", dismissLinkedLine);

    const unsubscribe = onDiffWorkerPoolReady(() => {
      if (disposed || !rootEl || fileInstance) return;
      void setDiffWorkerPoolTheme(isDark).then(() => {
        if (disposed || !rootEl || fileInstance) return;
        // No worker pool: the shared diff pool's render options win over a
        // File's per-instance options and it intentionally omits
        // `useTokenTransformer`, which the @pierre/diffs editor requires for an
        // editable AST. Rendering on the main thread honors our
        // `useTokenTransformer: true` so the editor can attach and accept input.
        fileInstance = new PierreFile(buildOptions());
        fileInstance.render({
          file: buildFile(contents),
          containerWrapper: rootEl,
        });
        editor = new Editor({
          onChange: (file) => scheduleSave(file.contents),
        });
        detachEditor = editor.edit(fileInstance);
        syncContainerBackground();
        revealLinkedLine();
      });
    });

    return () => {
      disposed = true;
      rootEl?.removeEventListener("pointerdown", dismissLinkedLine);
      unsubscribe();
      void flushSave();
      detachEditor?.();
      detachEditor = null;
      editor?.cleanUp();
      editor = null;
      fileInstance?.cleanUp();
      fileInstance = null;
    };
  });

  $effect(() => {
    void isDark;
    if (!fileInstance) return;
    void setDiffWorkerPoolTheme(isDark);
    untrack(() => fileInstance?.setOptions(buildOptions()));
    untrack(() => fileInstance?.setThemeType(isDark ? "dark" : "light"));
    untrack(() => syncContainerBackground());
  });

  $effect(() => {
    void filePath;
    void displayPath;
    void contents;
    lastSavedContents = contents;
    latestContents = contents;
    setSaveState("idle");
    if (!fileInstance) return;
    fileInstance.setOptions(buildOptions());
    fileInstance.render({ file: buildFile(contents), forceRender: true });
    untrack(() => syncContainerBackground());
    untrack(() => revealLinkedLine());
  });

  $effect(() => {
    if (!fileInstance) return;
    revealLinkedLine();
  });
</script>

<div
  bind:this={rootEl}
  class="pierre-file-host relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain text-[length:var(--solus-code-font-size,0.7813rem)] leading-[1.6]"
  style="scrollbar-width:thin"
></div>

<style>
  .pierre-file-host {
    --diffs-font-family: var(--solus-code-font-family);
    --diffs-font-size: var(--solus-code-font-size, 0.75rem);
    --diffs-line-height: calc(var(--solus-code-font-size, 0.75rem) * 1.6);
  }
  .pierre-file-host :global(diffs-component) {
    display: block;
  }
</style>
