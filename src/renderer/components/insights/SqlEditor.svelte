<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Compartment, EditorState, Prec } from "@codemirror/state";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import {
    HighlightStyle,
    syntaxHighlighting,
  } from "@codemirror/language";
  import {
    EditorView,
    keymap,
    lineNumbers,
    placeholder as placeholderExtension,
  } from "@codemirror/view";
  import { tags } from "@lezer/highlight";
  import {
    sqlEditorExtensions,
    type SqlEditorSources,
  } from "./lib/sql-editor-extensions";

  /**
   * The SQL surface of the query console: a real editor rather than a text box,
   * because a person writing a query needs to know the column exists before the
   * run button is pressed. Schema completion, SQLite-authoritative diagnostics,
   * and hover docs all come from the field registry through
   * `sql-editor-extensions`; this component only hosts the view.
   *
   * The language extensions live in a compartment so the schema can arrive
   * after the editor mounts without tearing the document down.
   */
  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    /** ⌘↵ — run what is written. */
    onRun: () => void;
    sources: SqlEditorSources;
    /** Rebuilds the language extensions; bump when the schema loads. */
    schemaRevision?: number;
    placeholder?: string;
    readOnly?: boolean;
  }

  let {
    value,
    onValueChange,
    onRun,
    sources,
    schemaRevision = 0,
    placeholder = "select tool, count(*) from events where kind = 'tool_call' group by 1",
    readOnly = false,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view = $state.raw<EditorView | null>(null);
  const language = new Compartment();

  // Terracotta for keywords, sage for strings, muted for comments — the same
  // roles the transcript's code blocks use, so SQL does not read as a different
  // product.
  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: "var(--solus-accent)" },
    { tag: [tags.string, tags.special(tags.string)], color: "var(--solus-art-3)" },
    { tag: tags.number, color: "var(--solus-art-5)" },
    { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: "var(--solus-art-4)" },
    { tag: tags.operator, color: "var(--muted-foreground)" },
  ]);

  const theme = EditorView.theme({
    "&": { backgroundColor: "transparent", fontSize: "0.8125rem" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { padding: "0", fontFamily: "var(--solus-font-mono, ui-monospace, monospace)" },
    ".cm-line": { padding: "0 0 0 0.5rem", lineHeight: "1.5rem" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--muted-foreground)",
      opacity: "0.5",
    },
    ".cm-lineNumbers .cm-gutterElement": { lineHeight: "1.5rem", minWidth: "1.25rem" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
    // Every panel this editor floats — completion, hover docs, diagnostics — is
    // the app's menu surface, composed from the same tokens as `menu-surface`
    // in index.css rather than a second popover language. CodeMirror owns this
    // DOM, so the tokens are read directly instead of through Tailwind.
    ".cm-tooltip": {
      background: "var(--solus-menu-bg)",
      border: "0",
      borderRadius: "0.875rem",
      boxShadow: "var(--solus-menu-shadow)",
      color: "var(--solus-text-primary)",
      overflow: "hidden",
      animation: "var(--animate-menu-pop-in)",
    },
    "@media (prefers-reduced-motion: reduce)": {
      ".cm-tooltip": { animation: "none" },
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--solus-font-mono, ui-monospace, monospace)",
      fontSize: "var(--text-menu)",
      maxHeight: "16.5rem",
      minWidth: "17rem",
      padding: "0.375rem",
    },
    // A bounded list reveals the standard thumb on hover, as the app's other
    // bounded lists do.
    ".cm-tooltip-autocomplete > ul:hover::-webkit-scrollbar-thumb": {
      background: "var(--solus-scroll-thumb)",
      backgroundClip: "padding-box",
    },
    // One row is one line, read left to right: icon, name, owning table, and
    // the data type pushed to the right edge — the layout a SQL IDE uses. The
    // list stays monospaced with the document, because every name in it is
    // about to be typed into the document. CodeMirror's own rule sets only
    // `overflow-x: hidden`, so without `nowrap` a long name wraps under its icon.
    ".cm-tooltip-autocomplete > ul > li": {
      alignItems: "center",
      borderRadius: "0.5rem",
      color: "var(--solus-text-secondary)",
      display: "flex",
      gap: "0.5rem",
      height: "2rem",
      lineHeight: "1.25",
      padding: "0 0.375rem",
      transition: "box-shadow var(--duration-quick) var(--ease-premium), color var(--duration-quick) var(--ease-premium)",
      whiteSpace: "nowrap",
    },
    // The same ink a menu row uses, laid on as an inset shadow so it washes the
    // row rather than replacing its background.
    ".cm-tooltip-autocomplete > ul > li:hover": {
      boxShadow: "inset 0 0 0 62rem var(--solus-menu-hover-ink)",
    },
    // Terracotta, not grey. The command palette marks its keyboard row with the
    // accent wash and lights the row's icon tile with it; a completion row is
    // the same object and takes the same treatment.
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "none",
      boxShadow: "inset 0 0 0 62rem var(--solus-accent-light)",
      color: "var(--solus-text-primary)",
    },
    ".cm-insights-completion-tile": {
      alignItems: "center",
      borderRadius: "0.5rem",
      color: "var(--solus-text-tertiary)",
      display: "inline-flex",
      flexShrink: "0",
      height: "1.375rem",
      justifyContent: "center",
      transition: "background var(--duration-quick) var(--ease-premium), color var(--duration-quick) var(--ease-premium)",
      width: "1.375rem",
    },
    // A clause has no glyph, so its tile stays an empty spacer rather than a
    // lit box around nothing.
    ".cm-insights-completion-tile[data-filled]": { background: "var(--solus-surface-hover)" },
    "li[aria-selected] .cm-insights-completion-tile[data-filled]": {
      background: "var(--solus-accent-soft)",
      color: "var(--solus-accent)",
    },
    ".cm-completionLabel": { flexShrink: "0", overflow: "hidden", textOverflow: "ellipsis" },
    // What the user typed, carried through the name so the eye can see why a
    // row is in the list. Weight and ink rather than colour: a terracotta
    // fragment in every row of a long list is louder than the list itself.
    ".cm-completionMatchedText": {
      color: "var(--solus-text-primary)",
      fontWeight: "600",
      textDecoration: "none",
    },
    // Sans and smaller: the owning table is context about the name, not part of
    // it, and a mono qualifier competes with the identifier it describes.
    ".cm-insights-completion-source": {
      color: "var(--solus-text-tertiary)",
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu-meta)",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    // Sans, because the type is prose about the row rather than something to
    // be typed — the same split the app's menus use between value and meta.
    ".cm-completionDetail": {
      color: "var(--solus-text-tertiary)",
      flexShrink: "0",
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu-meta)",
      fontStyle: "normal",
      marginLeft: "auto",
      paddingLeft: "1rem",
    },
    ".cm-insights-completion-icon": { fill: "currentColor", height: "0.8125rem", width: "0.8125rem" },
    // The documentation panel beside the selected row: prose, so it reads in
    // the app's sans at the menu's own measure.
    ".cm-completionInfo": {
      borderRadius: "0.875rem",
      color: "var(--solus-text-secondary)",
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu)",
      lineHeight: "1.5",
      margin: "0 0.375rem",
      maxWidth: "20rem",
      padding: "0.5rem 0.75rem",
    },
    ".cm-insights-hover": {
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu)",
      lineHeight: "1.5",
      maxWidth: "20rem",
      padding: "0.5rem 0.75rem",
    },
    ".cm-insights-hover-name": {
      fontFamily: "var(--solus-font-mono, ui-monospace, monospace)",
      fontWeight: "500",
    },
    ".cm-insights-hover-detail": { color: "var(--solus-text-tertiary)" },
    ".cm-tooltip.cm-tooltip-lint": { padding: "0.125rem" },
    ".cm-diagnostic": {
      borderRadius: "0.625rem",
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu)",
      lineHeight: "1.5",
      padding: "0.375rem 0.625rem",
    },
    ".cm-diagnostic-error": { borderLeftColor: "var(--failure)" },
  });

  $effect(() => {
    if (!host || view) return;
    const state = EditorState.create({
      doc: untrack(() => value),
      extensions: [
        lineNumbers(),
        history(),
        // Precedence above the default keymap so ⌘↵ runs the query instead of
        // inserting a newline.
        Prec.high(
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                onRun();
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(highlight),
        placeholderExtension(placeholder),
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
        theme,
        language.of(sqlEditorExtensions(sources)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onValueChange(update.state.doc.toString());
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
  });

  // The schema arrives after the first paint; swapping the compartment keeps
  // the document, selection, and undo history intact.
  $effect(() => {
    schemaRevision;
    const current = view;
    if (!current) return;
    current.dispatch({
      effects: language.reconfigure(sqlEditorExtensions(sources)),
    });
  });

  // A preset or a compiled query replaces the text from outside. Comparing
  // first keeps the user's own typing from being rewritten on every keystroke.
  $effect(() => {
    const next = value;
    const current = view;
    if (!current) return;
    const doc = current.state.doc.toString();
    if (doc === next) return;
    current.dispatch({
      changes: { from: 0, to: doc.length, insert: next },
      selection: { anchor: Math.min(next.length, current.state.selection.main.anchor) },
    });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  export function focus(): void {
    view?.focus();
  }

  /**
   * Write a schema column into the query where the cursor is.
   *
   * A reference is only worth opening if what it documents can be used without
   * being retyped, so the schema sheet hands column names here. The leading
   * space is conditional: `select ` and `(` already separate, `duration` does
   * not, and gluing two identifiers together would produce a query that no
   * longer parses.
   */
  export function insertAtCursor(text: string): void {
    const current = view;
    if (!current || readOnly) return;
    const { from, to } = current.state.selection.main;
    const before = from > 0 ? current.state.doc.sliceString(from - 1, from) : "";
    const insert = before && !/[\s(,.]/.test(before) ? ` ${text}` : text;
    current.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    current.focus();
  }
</script>

<div
  bind:this={host}
  class="min-h-13 max-h-40 w-full overflow-auto text-[0.8125rem]"
  data-sb
></div>
