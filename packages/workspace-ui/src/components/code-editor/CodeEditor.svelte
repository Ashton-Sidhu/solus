<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers, placeholder as placeholderExtension, type KeyBinding } from "@codemirror/view";
  import { codeEditorTheme, type CodeEditorSize } from "./lib/code-editor-theme";
  import { codeLanguage, type CodeLanguage } from "./lib/code-languages";
  import { codeMarksField, fixAtCursor, setCodeMarks, type CodeFix, type CodeLineMark, type CodeProblem } from "./lib/code-marks";

  /**
   * The one code editor of Solus: line numbers, colors from Solus tokens, and
   * what its owner gives it — completion, problems with their quick fixes,
   * marked lines, and the keys ⌘S and ⌘↵. Read-only, it is a code viewer that
   * still takes the cursor, so a reader moves and selects with the keys.
   *
   * The owner keeps the text and reads it; the editor only hosts the view.
   * The language and the owner's extensions live in a compartment, so a
   * schema that arrives after the editor mounts does not tear the document
   * down.
   */
  interface Props {
    value: string;
    /** Absent for a read-only editor. */
    onChange?: (value: string) => void;
    readOnly?: boolean;
    /** Takes the keyboard when it mounts, as the editor of a sheet does. */
    autofocus?: boolean;
    language?: CodeLanguage;
    size?: CodeEditorSize;
    ariaLabel: string;
    placeholder?: string;
    lineWrapping?: boolean;
    /** Completion for the text, such as the fields of a JSON schema. */
    complete?: CompletionSource;
    /** More language intelligence: the Insights SQL. */
    extensions?: Extension[];
    /** Rebuilds the completion and the extensions; change it when their source changes. */
    extensionsKey?: unknown;
    problems?: readonly CodeProblem[];
    lineMarks?: readonly CodeLineMark[];
    /** The line the reader opened the text at: tinted and in view. */
    focusLine?: number | null;
    /** The cursor moved: its line and column, from 1. */
    onCursor?: (line: number, column: number) => void;
    /** ⌘S. */
    onSave?: () => void;
    /** ⌘↵. */
    onRun?: () => void;
    class?: string;
    testId?: string;
  }
  let {
    value,
    onChange,
    readOnly = false,
    autofocus = false,
    language = "json",
    size = "document",
    ariaLabel,
    placeholder,
    lineWrapping = false,
    complete,
    extensions = [],
    extensionsKey,
    problems = [],
    lineMarks = [],
    focusLine = null,
    onCursor,
    onSave,
    onRun,
    class: className = "",
    testId,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view = $state.raw<EditorView | null>(null);
  const languageParts = new Compartment();

  function languageExtensions(): Extension[] {
    return [codeLanguage(language), ...(complete ? [autocompletion({ override: [complete], icons: false })] : []), ...extensions];
  }

  /** Replaces a span of the text, as the person's own edit: it is undone with ⌘Z. */
  export function replace(change: { from: number; to: number; insert: string }): void {
    const current = view;
    if (!current) return;
    current.dispatch({ changes: change, selection: { anchor: change.from + change.insert.length }, scrollIntoView: true, userEvent: "input" });
    current.focus();
  }

  export function focus(): void {
    view?.focus();
  }

  /** The selection, and the character before it: an owner that inserts text reads it first. */
  export function selection(): { from: number; to: number; before: string } | null {
    const current = view;
    if (!current) return null;
    const { from, to } = current.state.selection.main;
    return { from, to, before: from > 0 ? current.state.doc.sliceString(from - 1, from) : "" };
  }

  function applyFix(problem: CodeProblem, fix: CodeFix) {
    replace({ from: problem.from, to: problem.to, insert: fix.insert });
  }

  $effect(() => {
    if (!host || view) return;
    const keys: KeyBinding[] = [{ key: "Mod-.", run: fixAtCursor }];
    if (onSave) keys.push({ key: "Mod-s", preventDefault: true, run: () => (onSave?.(), true) });
    if (onRun) keys.push({ key: "Mod-Enter", preventDefault: true, run: () => (onRun?.(), true) });
    const state = EditorState.create({
      doc: untrack(() => value),
      extensions: [
        lineNumbers(),
        history(),
        // Above the default keymap, so ⌘↵ runs instead of a new line.
        Prec.high(keymap.of(keys)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        codeEditorTheme(untrack(() => size)),
        codeMarksField,
        untrack(() => languageParts.of(languageExtensions())),
        ...(untrack(() => readOnly) ? [EditorState.readOnly.of(true)] : []),
        ...(untrack(() => lineWrapping) ? [EditorView.lineWrapping] : []),
        ...(untrack(() => placeholder) ? [placeholderExtension(untrack(() => placeholder) ?? "")] : []),
        EditorView.contentAttributes.of({ "aria-label": untrack(() => ariaLabel), spellcheck: "false", "aria-readonly": untrack(() => readOnly) ? "true" : "false" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString());
          if (onCursor && (update.docChanged || update.selectionSet)) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            onCursor(line.number, head - line.from + 1);
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    if (untrack(() => autofocus)) view.focus();
  });

  // A new schema or source of completion swaps the compartment: the text, the selection, and the undo history stay.
  $effect(() => {
    void extensionsKey;
    void language;
    const current = view;
    if (!current) return;
    current.dispatch({ effects: languageParts.reconfigure(untrack(languageExtensions)) });
  });

  // The owner replaces the text from outside (a save, a preset). Comparing first keeps the person's own typing as it is.
  $effect(() => {
    const next = value;
    const current = view;
    if (!current) return;
    const doc = current.state.doc.toString();
    if (doc === next) return;
    current.dispatch({ changes: { from: 0, to: doc.length, insert: next }, selection: { anchor: Math.min(next.length, current.state.selection.main.anchor) } });
  });

  // The marks follow the owner's reading of each edit.
  $effect(() => {
    const marks = { problems, lines: lineMarks, focusLine, applyFix };
    const current = view;
    if (!current) return;
    // The text effect above runs first, so the marks are drawn on the text they were read from.
    if (current.state.doc.toString() !== untrack(() => value)) return;
    current.dispatch({ effects: setCodeMarks.of(marks) });
  });

  // The line the reader opened the text at comes into view, with the cursor on it.
  $effect(() => {
    const line = focusLine;
    const current = view;
    if (!current || line === null || line < 1 || line > current.state.doc.lines) return;
    const from = current.state.doc.line(line).from;
    current.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });
</script>

<div bind:this={host} class="min-w-0 {className}" data-testid={testId}></div>
