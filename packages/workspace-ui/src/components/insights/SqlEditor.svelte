<script lang="ts">
  import {
    HighlightStyle,
    syntaxHighlighting,
  } from "@codemirror/language";
  import { EditorView } from "@codemirror/view";
  import { tags } from "@lezer/highlight";
  import CodeEditor from "../code-editor/CodeEditor.svelte";
  import {
    sqlEditorExtensions,
    type SqlEditorSources,
  } from "./lib/sql-editor-extensions";

  /**
   * The SQL surface of the query console: the shared code editor rather than a text box,
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
    /** The inline console shows seven rows.
     *  The pop-out takes the editor into a focused, viewport-bounded surface. */
    surface?: "inline" | "popout";
  }

  let {
    value,
    onValueChange,
    onRun,
    sources,
    schemaRevision = 0,
    placeholder = "select tool, count(*) from events where kind = 'tool_call' group by 1",
    surface = "inline",
  }: Props = $props();

  let editor = $state<ReturnType<typeof CodeEditor> | null>(null);

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

  // The parts of the menu only the SQL completion draws: the icon tile, the
  // owning table, and the hover docs. The menu surface itself is the shared
  // editor's.
  const theme = EditorView.theme({
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
    // Sans and smaller: the owning table is context about the name, not part of
    // it, and a mono qualifier competes with the identifier it describes.
    ".cm-insights-completion-source": {
      color: "var(--solus-text-tertiary)",
      fontFamily: "var(--solus-font-sans, ui-sans-serif, sans-serif)",
      fontSize: "var(--text-menu-meta)",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-insights-completion-icon": { fill: "currentColor", height: "0.8125rem", width: "0.8125rem" },
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
  });

  // The schema arrives after the first paint; a new revision rebuilds these in
  // the editor's compartment, which keeps the document, selection, and undo
  // history intact.
  const extensions = $derived.by(() => {
    void schemaRevision;
    return [syntaxHighlighting(highlight), theme, ...sqlEditorExtensions(sources)];
  });

  export function focus(): void {
    editor?.focus();
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
    const selection = editor?.selection();
    if (!selection) return;
    const insert = selection.before && !/[\s(,.]/.test(selection.before) ? ` ${text}` : text;
    editor?.replace({ from: selection.from, to: selection.to, insert });
  }
</script>

<div
  class="w-full text-insights-chrome {surface === 'popout'
    ? 'min-h-13 overflow-visible'
    : 'h-[10.5rem] overflow-auto'}"
  data-sb
>
  <CodeEditor
    bind:this={editor}
    {value}
    onChange={onValueChange}
    {onRun}
    language="text"
    size="console"
    ariaLabel="SQL query"
    {placeholder}
    lineWrapping
    {extensions}
    extensionsKey={extensions}
  />
</div>
