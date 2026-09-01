<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { File as PierreFile, type FileContents, type FileOptions } from "@pierre/diffs";
  import { Editor } from "@pierre/diffs/edit";
  import { getSettingsContext } from "../../contexts";
  import { DIFFS_THEME_CSS } from "../../lib/diffTheme";
  import {
    getDiffThemeName,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
  } from "../../lib/diff-worker-pool";

  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    onInput?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    readOnly?: boolean;
    fileName?: string;
    class?: string;
  }

  let {
    value,
    onValueChange,
    onInput,
    onFocus,
    onBlur,
    readOnly = false,
    fileName = "document.md",
    class: klass = "",
  }: Props = $props();

  const settings = getSettingsContext();
  let rootEl: HTMLDivElement | null = $state(null);
  let fileInstance: PierreFile<never> | null = null;
  let editor: Editor<never> | null = null;
  let detachEditor: (() => void) | null = null;
  let currentValue = untrack(() => value);

  function buildFile(contents = currentValue): FileContents {
    return { name: fileName, contents, lang: "markdown" };
  }

  function buildOptions(): FileOptions<never> {
    return {
      theme: getDiffThemeName(settings.isDark),
      themeType: settings.isDark ? "dark" : "light",
      useTokenTransformer: true,
      lineHoverHighlight: "disabled",
      overflow: "wrap",
      disableFileHeader: true,
      disableErrorHandling: true,
      enableGutterUtility: false,
      enableLineSelection: false,
      unsafeCSS: DIFFS_THEME_CSS,
      onPostRender: () => {
        const container = rootEl?.firstElementChild;
        if (container instanceof HTMLElement) {
          container.style.backgroundColor = "transparent";
        }
      },
    };
  }

  function render(contents: string) {
    currentValue = contents;
    fileInstance?.render({ file: buildFile(contents), forceRender: true });
  }

  export function getValue(): string {
    return editor?.getText() ?? currentValue;
  }

  export function focus(options?: FocusOptions) {
    editor?.focus(options);
  }

  onMount(() => {
    if (!rootEl) return;
    let disposed = false;

    // Render without waiting for the highlighter worker pool. The pool only
    // moves tokenization off the main thread; this editor never hands its
    // instance to one, and a pool that fails to spawn never reports ready at
    // all — which used to leave the whole source view permanently blank with
    // nothing to see or act on. Highlighting quality may degrade; the editor
    // must not disappear.
    void setDiffWorkerPoolTheme(settings.isDark);
    fileInstance = new PierreFile<never>(buildOptions());
    fileInstance.render({ file: buildFile(value), containerWrapper: rootEl });
    if (!readOnly) {
      editor = new Editor<never>({
        onChange: (file) => {
          currentValue = file.contents;
          onInput?.();
          onValueChange(file.contents);
        },
        onFocus,
        onBlur,
      });
      detachEditor = editor.edit(fileInstance);
    }

    // Once the pool does come up it owns the render theme, so re-apply the
    // options the instance was built with rather than leaving it on the
    // pool's initialization theme.
    const unsubscribe = onDiffWorkerPoolReady(() => {
      if (disposed || !fileInstance) return;
      fileInstance.setOptions(buildOptions());
    });

    return () => {
      disposed = true;
      unsubscribe();
      detachEditor?.();
      editor?.cleanUp();
      fileInstance?.cleanUp();
      detachEditor = null;
      editor = null;
      fileInstance = null;
    };
  });

  $effect(() => {
    const nextValue = value;
    void fileName;
    if (!fileInstance || nextValue === currentValue) return;
    untrack(() => render(nextValue));
  });

  $effect(() => {
    void settings.isDark;
    if (!fileInstance) return;
    void setDiffWorkerPoolTheme(settings.isDark);
    untrack(() => fileInstance?.setOptions(buildOptions()));
    untrack(() => fileInstance?.setThemeType(settings.isDark ? "dark" : "light"));
  });
</script>

<div
  bind:this={rootEl}
  class="raw-markdown-editor min-h-50 w-full min-w-0 overflow-y-auto overscroll-y-contain {klass}"
></div>

<style>
  .raw-markdown-editor {
    --diffs-font-family: var(--solus-code-font-family);
    --diffs-font-size: var(--solus-code-font-size, 0.8125rem);
    --diffs-line-height: calc(var(--solus-code-font-size, 0.8125rem) * 1.6);
  }
  .raw-markdown-editor :global(diffs-component) {
    display: block;
    min-height: 100%;
  }
</style>
