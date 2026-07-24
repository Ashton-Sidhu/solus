<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import type {
    AgentId,
    PlanReference,
    PluginCommandsResult,
    SessionReference,
    WorkReference,
  } from "../../../shared/types";
  import PlanAutocompleteMenu from "../plan/PlanAutocompleteMenu.svelte";
  import WorkAutocompleteMenu from "../work/WorkAutocompleteMenu.svelte";
  import PrAutocompleteMenu from "../prs/PrAutocompleteMenu.svelte";
  import SessionAutocompleteMenu from "../session/SessionAutocompleteMenu.svelte";
  import SlashCommandMenu from "../input/SlashCommandMenu.svelte";
  import type { SlashCommand } from "../input/slash-commands";
  import FileAutocompleteMenu from "../input/FileAutocompleteMenu.svelte";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import type { Transaction } from "@tiptap/pm/state";
  import * as refs from "../editor/references";
  import { AutocompleteController } from "../editor/autocomplete.svelte";

  interface Props {
    value: string;
    onValueChange: (md: string) => void;
    /** Plugin/skill/builtin command set used to populate the slash menu. */
    pluginCommands: PluginCommandsResult;
    /** Provider whose built-in commands appear in the slash menu. */
    provider: AgentId;
    /** Directory used for @-file search, plan preload, and work loading. */
    workingDirectory: string | undefined;
    /** Notified whenever the editor's plan/work/session references change. */
    onRefsChange?: (
      planRefs: PlanReference[],
      workRefs: WorkReference[],
      sessionRefs: SessionReference[],
    ) => void;
    /** Synchronous emptiness signal (see MarkdownEditor) — lets callers gate
     *  UI like a send button without waiting on the debounced markdown emit. */
    onEmptyChange?: (empty: boolean) => void;
    /** Include Solus built-in commands (/clear …) in the slash menu. The input
     *  bar wants them; the automation editor does not. */
    includeSolusCommands?: boolean;
    /** Invoked when a Solus built-in command is accepted — the caller decides
     *  whether to execute it or insert text. Only fires when
     *  `includeSolusCommands` is true. */
    onSolusCommand?: (cmd: SlashCommand) => void;
    /** Forwarded keydown — only fires when no autocomplete menu consumed it. */
    onKeyDown?: (e: KeyboardEvent) => void;
    /** When true, plain Enter inserts a newline instead of being swallowed for a
     *  send action. Used by editors with no "send" (e.g. the automation prompt). */
    enterInsertsNewline?: boolean;
    onPaste?: (e: ClipboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onPlanRefClick?: (planId: string) => void;
    onWorkRefClick?: (workId: string, title?: string) => void;
    onPrRefClick?: (number: number, title?: string) => void;
    onFileRefClick?: (path: string) => void;
    placeholder?: string;
    /** Blocks ref insertion / command execution (read-only session). */
    readOnly?: boolean;
    /** Disables the underlying editor (read-only, connecting, transcribing…). */
    disabled?: boolean;
    maxHeight?: number;
    class?: string;
    /** Whether autocomplete menus grow upward (above the cursor) or downward.
     *  Composers anchored near the top of the screen (e.g. the task modal) want
     *  "down" so menus don't clip off the top edge. */
    menuPlacement?: "up" | "down";
    /** Insert @-file references as project-relative paths (FileMatch.display)
     *  instead of absolute paths. Used where the prompt is persisted and read
     *  back inside the project (e.g. a task description). */
    useRelativeFilePaths?: boolean;
  }

  let {
    value,
    onValueChange,
    pluginCommands,
    provider,
    workingDirectory,
    onRefsChange,
    onEmptyChange,
    includeSolusCommands = false,
    onSolusCommand,
    onKeyDown,
    enterInsertsNewline = false,
    onPaste,
    onFocus,
    onBlur,
    onPlanRefClick,
    onWorkRefClick,
    onPrRefClick,
    onFileRefClick,
    placeholder = "",
    readOnly = false,
    disabled = false,
    maxHeight = 140,
    class: klass = "",
    menuPlacement = "up",
    useRelativeFilePaths = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  let markdownEditorEl: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let fileMenuEl: ReturnType<typeof FileAutocompleteMenu> | null = $state(null);
  const ed = () => markdownEditorEl?.getEditor() ?? null;

  // The reference-autocomplete state machine. It operates on the raw Tiptap
  // editor (via the accessors below), so this component is just the menu host.
  const ac = new AutocompleteController({
    readOnly: () => readOnly,
    workingDirectory: () => workingDirectory,
    useRelativeFilePaths: () => useRelativeFilePaths,
    provider: () => provider,
    includeSolusCommands: () => includeSolusCommands,
    pluginCommands: () => pluginCommands,
    onSolusCommand: () => onSolusCommand,
    onRefsChange: () => onRefsChange,
    session,
    planStore,
    getEditor: ed,
    focusEditor: () => markdownEditorEl?.focus(),
    getCursorRect: () => markdownEditorEl?.getCursorRect() ?? null,
    getFileMenu: () => fileMenuEl,
  });

  // Emit refs parsed from the starting value once the editor mounts. setContent
  // fires no update event, so without this a caller editing an automation never
  // learns about the plan/work tokens already in the saved prompt.
  $effect(() => {
    if (markdownEditorEl) untrack(() => ac.syncRefs());
  });

  // Synchronous per-keystroke channel: autocomplete triggers must track the
  // caret immediately, not after the debounced markdown emit.
  function handleEditorInput(transaction: Transaction | null) {
    if (readOnly) return;
    ac.handleEditorChange(
      refs.textBeforeCursor(ed()),
      transaction === null || refs.transactionChangesTrackedRefs(transaction),
    );
  }

  function handleEditorChange(md: string) {
    if (readOnly) return;
    onValueChange(md);
  }

  function handleKeyDown(e: KeyboardEvent) {
    // A menu consumed the key; otherwise hand back to the caller (history nav,
    // send, …).
    if (ac.handleKeyDown(e)) return;
    onKeyDown?.(e);
  }

  // ─── Exposed editor methods ───

  export function clearCompletions() {
    ac.clearCompletions();
  }
  export function focus() {
    markdownEditorEl?.focus();
  }
  export function setValueAndCursor(
    text: string,
    autoFocus = true,
    ensureTrailingParagraph = false,
  ) {
    markdownEditorEl?.setValueAndCursor(
      text,
      autoFocus,
      ensureTrailingParagraph,
    );
    // Re-evaluate the slash trigger so prompt-history navigation keeps the
    // command menu in sync (setContent fires no editor update).
    ac.updateSlashFilter(untrack(() => refs.textBeforeCursor(ed()) || text));
  }
  export function clearEditor() {
    markdownEditorEl?.clearEditor();
    ac.clearCompletions();
  }
  export function isCaretAtStart(): boolean {
    return refs.isCaretAtStart(ed());
  }
</script>

{#if ac.showSlashMenu}
  <SlashCommandMenu
    filter={ac.slashFilter!}
    selectedIndex={ac.slashIndex}
    onSelect={ac.handleSlashSelect}
    anchorRect={ac.cursorAnchorRect}
    commands={ac.commands}
    placement={menuPlacement}
  />
{/if}

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

{#if ac.showPrMenu}
  <PrAutocompleteMenu
    pullRequests={ac.prResults}
    isLoading={ac.isPrMenuLoading}
    selectedIndex={ac.prIndex}
    onSelect={ac.handlePrSelect}
    anchorRect={ac.cursorAnchorRect}
    placement={menuPlacement}
  />
{/if}

{#if ac.showSessionMenu}
  <SessionAutocompleteMenu
    sessions={ac.sessionResults}
    isLoading={ac.isSessionMenuLoading}
    selectedIndex={ac.sessionIndex}
    onSelect={ac.handleSessionSelect}
    anchorRect={ac.cursorAnchorRect}
    placement={menuPlacement}
  />
{/if}

<MarkdownEditor
  bind:this={markdownEditorEl}
  {value}
  onValueChange={handleEditorChange}
  onInput={handleEditorInput}
  {onEmptyChange}
  onKeyDown={handleKeyDown}
  {enterInsertsNewline}
  {onPaste}
  onFocus={() => {
    ac.updateCursorAnchor();
    onFocus?.();
  }}
  {onBlur}
  {onPlanRefClick}
  {onWorkRefClick}
  {onPrRefClick}
  {onFileRefClick}
  {placeholder}
  {disabled}
  {maxHeight}
  class={klass}
/>
