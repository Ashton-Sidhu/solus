<script module lang="ts">
  import type PromptEditorComponent from "./PromptEditor.svelte";

  // The prompt editor (CodeMirror, Markdown, and the autocomplete menus) is
  // the largest part of the first screen. It starts to load with this module,
  // in parallel with the rest of the workspace, but it is not in the
  // workspace's own chunks. Until it runs, a plain text field holds the draft.
  // The loaded module is kept as state: an await block would draw the stand-in
  // for a frame on every later mount. The build renders the stand-in into the
  // web page's HTML (docs/plans/fast-secure-startup.md, step 5): there is no
  // document then, and the editor does not load.
  let LoadedEditor = $state<typeof PromptEditorComponent | null>(null);
  if (!import.meta.env.SSR) {
    import("./PromptEditor.svelte").then(
      (module) => (LoadedEditor = module.default),
      // The stand-in stays and still sends; the console says why.
      (error: Error) => console.error("prompt_editor_load_failed", error),
    );
  }
</script>

<script lang="ts">
  import type { ComponentProps } from "svelte";
  import type { SessionReference } from "@solus/contracts/types";

  /**
   * The input bar's prompt editor. Same props and commands as `PromptEditor`.
   * Before its code has loaded, the stand-in field takes text, Enter, paste,
   * and focus, so the person can type at once. The editor then takes the
   * draft (it reads the same `value`) and, when the field had focus, the focus.
   */
  let props: ComponentProps<typeof PromptEditorComponent> = $props();

  let editor = $state<PromptEditorComponent | null>(null);
  let standIn = $state<HTMLTextAreaElement | null>(null);
  /** A focus asked for before even the stand-in was there; the editor honours it. */
  let isFocusRequested = false;
  /** Read while the stand-in is still in the document, before it is removed. */
  let standInHadFocus = false;

  $effect.pre(() => {
    if (LoadedEditor && standIn && document.activeElement === standIn) standInHadFocus = true;
  });

  $effect(() => {
    if (!editor) return;
    if (isFocusRequested || standInHadFocus) editor.focus();
    isFocusRequested = false;
    standInHadFocus = false;
  });

  export function clearCompletions() {
    editor?.clearCompletions();
  }
  export function focus() {
    if (editor) editor.focus();
    else if (standIn) standIn.focus();
    else isFocusRequested = true;
  }
  export function setValueAndCursor(text: string, autoFocus = true, ensureTrailingParagraph = false) {
    // The stand-in shows `value`, which the caller has already set.
    if (editor) editor.setValueAndCursor(text, autoFocus, ensureTrailingParagraph);
    else if (autoFocus) focus();
  }
  export function clearEditor() {
    editor?.clearEditor();
  }
  export function insertTranscript(transcript: string) {
    if (editor) editor.insertTranscript(transcript);
    else props.onValueChange(props.value ? `${props.value} ${transcript}` : transcript);
  }
  export function isCaretAtStart(): boolean {
    if (editor) return editor.isCaretAtStart();
    return !standIn || (standIn.selectionStart === 0 && standIn.selectionEnd === 0);
  }
  export function insertSessionReferences(sessions: readonly SessionReference[]): boolean {
    return editor?.insertSessionReferences(sessions) ?? false;
  }
</script>

{#if LoadedEditor}
  <LoadedEditor bind:this={editor} {...props} />
{:else}
  <textarea
    bind:this={standIn}
    value={props.value}
    rows="1"
    placeholder={props.placeholder}
    aria-label={props.ariaLabel || props.placeholder || "Message input"}
    readonly={props.readOnly}
    disabled={props.disabled}
    spellcheck="false"
    autocomplete="off"
    oninput={(event) => {
      props.onValueChange(event.currentTarget.value);
      props.onEmptyChange?.(event.currentTarget.value.length === 0);
    }}
    onkeydown={(event) => props.onKeyDown?.(event)}
    onpaste={(event) => props.onPaste?.(event)}
    onfocus={() => props.onFocus?.()}
    onblur={() => props.onBlur?.()}
    style:max-height="{props.maxHeight ?? 140}px"
    class="block min-h-5 w-full resize-none overflow-y-auto border-0 bg-transparent py-[0.9375rem] pr-0 pl-1 font-[inherit] text-(length:--plain-editor-font-size,var(--text-body)) leading-(--plain-editor-line-height,normal) text-(--solus-text-primary) outline-none [field-sizing:content] placeholder:text-(--solus-placeholder) {props.class ?? ''}"
  ></textarea>
{/if}
