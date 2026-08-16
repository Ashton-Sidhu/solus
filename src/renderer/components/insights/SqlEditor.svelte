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
    placeholder = "select tool, count(*) from tool_calls group by 1",
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
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      border: "none",
      borderRadius: "0.5rem",
      boxShadow: "var(--elev-lift)",
      color: "var(--foreground)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--wash-3)",
      color: "var(--foreground)",
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
</script>

<div
  bind:this={host}
  class="min-h-16 max-h-40 w-full overflow-auto text-[0.8125rem]"
  data-sb
></div>
