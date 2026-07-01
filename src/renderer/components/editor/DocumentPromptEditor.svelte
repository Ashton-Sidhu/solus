<script lang="ts">
  import type { AnyExtension, Editor } from "@tiptap/core";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getPlanStore } from "../../contexts/plan.store.svelte";
  import type {
    AgentId,
    PlanReference,
    PluginCommandsResult,
    WorkReference,
  } from "../../../shared/types";
  import DocumentEditor from "./DocumentEditor.svelte";
  import { referenceExtensions } from "./referenceExtensions";
  import * as refs from "./references";
  import { AutocompleteController } from "./autocomplete.svelte";
  import FileAutocompleteMenu from "../input/FileAutocompleteMenu.svelte";
  import PlanAutocompleteMenu from "../plan/PlanAutocompleteMenu.svelte";
  import WorkAutocompleteMenu from "../work/WorkAutocompleteMenu.svelte";

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
  let fileMenuEl: ReturnType<typeof FileAutocompleteMenu> | null = $state(null);
  const ed = () => docEl?.getEditor() ?? null;

  // The reference-autocomplete machine, with the `/` channel off — the document
  // editor's own block-command menu owns `/`. Only @ # % insert references here.
  const ac = new AutocompleteController({
    readOnly: () => readOnly,
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
    getEditor: ed,
    focusEditor: () => docEl?.focus(),
    getCursorRect: () => docEl?.getCursorRect() ?? null,
    getFileMenu: () => fileMenuEl,
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
    ac.handleEditorChange(refs.textBeforeCursor(ed()));
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

{#if ac.showFileMenu}
  <FileAutocompleteMenu
    bind:this={fileMenuEl}
    files={ac.fileResults}
    onSelect={ac.handleFileSelect}
    anchorRect={ac.cursorAnchorRect}
    placement={menuPlacement}
  />
{/if}

{#if ac.showPlanMenu}
  <PlanAutocompleteMenu
    plans={ac.planResults}
    isLoading={ac.isPlanMenuLoading}
    selectedIndex={ac.planIndex}
    onSelect={ac.handlePlanSelect}
    anchorRect={ac.cursorAnchorRect}
    placement={menuPlacement}
  />
{/if}

{#if ac.showWorkMenu}
  <WorkAutocompleteMenu
    works={ac.workResults}
    isLoading={ac.isWorkMenuLoading}
    selectedIndex={ac.workIndex}
    onSelect={ac.handleWorkSelect}
    anchorRect={ac.cursorAnchorRect}
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
