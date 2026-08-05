<script lang="ts">
  import type { AnyExtension, Editor } from "@tiptap/core";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import type {
    AgentId,
    PlanReference,
    PluginCommandsResult,
    WorkReference,
  } from "../../../shared/types";
  import DocumentEditor from "./DocumentEditor.svelte";
  import { referenceExtensions } from "./referenceExtensions";
  import { UnifiedAutocompleteController } from "./autocomplete.svelte";
  import { createTiptapAutocompleteAdapter } from "./tiptap-autocomplete-adapter";
  import UnifiedAutocompleteMenu from "../input/UnifiedAutocompleteMenu.svelte";

  interface Props {
    value: string;
    /** Debounced markdown — fired off the keystroke hot path. */
    onValueChange: (md: string) => void;
    /** Cheap synchronous per-edit signal (host marks dirty / flushes). */
    onInput?: () => void;
    pluginCommands: PluginCommandsResult;
    provider: AgentId;
    workingDirectory: string | undefined;
    onRefsChange?: (planRefs: PlanReference[], workRefs: WorkReference[]) => void;
    /** Fired when no autocomplete menu consumed the key (e.g. Cmd+Enter submit). */
    onKeyDown?: (e: KeyboardEvent) => void;
    onPlanRefClick?: (planId: string) => void;
    onWorkRefClick?: (workId: string, title?: string) => void;
    onPrRefClick?: (number: number, title?: string) => void;
    onFileRefClick?: (path: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onEditorReady?: (editor: Editor) => void;
    onModeChange?: (mode: "rich" | "raw") => void;
    extraExtensions?: AnyExtension[];
    placeholder?: string;
    readOnly?: boolean;
    /** Caps the editor height; content scrolls past it (inline composers). */
    maxHeight?: number;
    class?: string;
    style?: string;
    menuPlacement?: "up" | "down";
    useRelativeFilePaths?: boolean;
    /** Mount the hover-to-grab block drag handle. Off for the task description. */
    dragHandle?: boolean;
  }

  let {
    value,
    onValueChange,
    onInput,
    pluginCommands,
    provider,
    workingDirectory,
    onRefsChange,
    onKeyDown,
    onPlanRefClick,
    onWorkRefClick,
    onPrRefClick,
    onFileRefClick,
    onFocus,
    onBlur,
    onEditorReady,
    onModeChange,
    extraExtensions = [],
    placeholder = "",
    readOnly = false,
    maxHeight,
    class: klass = "",
    style = "",
    menuPlacement = "down",
    useRelativeFilePaths = false,
    dragHandle = true,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  let docEl: ReturnType<typeof DocumentEditor> | null = $state(null);
  const ed = () => docEl?.getEditor() ?? null;
  const autocompleteEditor = createTiptapAutocompleteAdapter(
    ed,
    () => docEl?.focus(),
    () => docEl?.getCursorRect() ?? null,
  );

  // The reference-autocomplete machine, with the `/` channel off — the document
  // editor's own block-command menu owns `/`. Only @ and # insert references here.
  const ac = new UnifiedAutocompleteController({
    readOnly: () => readOnly,
    tabId: () => session.activeTabId,
    workingDirectory: () => workingDirectory,
    useRelativeFilePaths: () => useRelativeFilePaths,
    provider: () => provider,
    includeSolusCommands: () => false,
    pluginCommands: () => pluginCommands,
    onSolusCommand: () => undefined,
    onRefsChange: () => onRefsChange,
    enableSlash: () => false,
    session,
    planStore,
    getEditor: () => autocompleteEditor,
  });

  // Reference nodes first, then any host-supplied extensions (e.g. comments).
  // Derived so the reactive `extraExtensions` prop is tracked; DocumentEditor
  // reads it once at init.
  const allExtensions: AnyExtension[] = $derived([
    ...referenceExtensions,
    ...extraExtensions,
  ]);

  const styleAttr = $derived(
    maxHeight ? `max-height:${maxHeight}px;overflow-y:auto;${style}` : style,
  );

  function handleEditorReady(editor: Editor) {
    onEditorReady?.(editor);
    // Emit refs already present in the starting value (setContent fires no update).
    ac.syncRefs();
  }

  function handleInput() {
    onInput?.();
    ac.handleEditorChange(autocompleteEditor.textBeforeCursor());
  }

  function handleKeyDown(e: KeyboardEvent): boolean {
    if (ac.handleKeyDown(e)) return true;
    onKeyDown?.(e);
    return e.defaultPrevented;
  }

  // ─── Exposed methods ───

  export function focus() {
    docEl?.focus();
  }
  /** Latest markdown (mode-aware), flushing any pending debounce. For hosts that
   *  read content on submit/blur rather than the debounced `onValueChange`. */
  export function getMarkdown(): string {
    return docEl?.getCurrentMarkdown() ?? "";
  }
  export function clearCompletions() {
    ac.clearCompletions();
  }
  export function getMode(): "rich" | "raw" {
    return docEl?.getMode() ?? "rich";
  }
  export function toggleMode() {
    docEl?.toggleMode();
  }
  export function getEditor(): Editor | null {
    return ed();
  }
</script>

{#if ac.open}
  <UnifiedAutocompleteMenu
    rows={ac.rows}
    selectedIndex={ac.selectedIndex}
    anchorRect={ac.cursorAnchorRect}
    onActivate={ac.activate}
    onHover={ac.hoverRow}
    onBack={ac.leaveScope}
    enterVerb={ac.enterVerb}
    tabVerb={ac.tabVerb}
    showTabHint={ac.showTabHint}
    footer={ac.footer}
    placement={menuPlacement}
  />
{/if}

<DocumentEditor
  bind:this={docEl}
  {value}
  {onValueChange}
  onInput={handleInput}
  onKeyDown={handleKeyDown}
  onEditorReady={handleEditorReady}
  {onModeChange}
  {onPlanRefClick}
  {onWorkRefClick}
  {onPrRefClick}
  {onFileRefClick}
  {onFocus}
  {onBlur}
  extraExtensions={allExtensions}
  {placeholder}
  {readOnly}
  {dragHandle}
  class={`doc-prompt-editor ${klass}`}
  style={styleAttr}
/>
