<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import type {
    AgentId,
    PlanReference,
    PluginCommandsResult,
    SessionReference,
    WorkReference,
  } from "@solus/contracts/types";
  import UnifiedAutocompleteMenu from "../input/UnifiedAutocompleteMenu.svelte";
  import type { SlashCommand } from "../input/slash-commands";
  import PlainTextEditor from "./plain-text-editor/plain-text-editor.svelte";
  import { UnifiedAutocompleteController } from "../editor/autocomplete.svelte";
  import type { AutocompleteEditor } from "../editor/autocomplete-editor";
  import { resolveAutocompleteScope } from "../editor/autocomplete-scope";
  import { createReferenceNavigation } from "../editor/reference-navigation";

  interface Props {
    value: string;
    onValueChange: (md: string) => void;
    /** Plugin/skill/builtin command set used to populate the slash menu. */
    pluginCommands: PluginCommandsResult;
    /** Provider whose built-in commands appear in the slash menu. */
    provider: AgentId;
    /** Directory used for @-file search, plan preload, and work loading. */
    workingDirectory: string | undefined;
    /** Session tab whose checkout and host own autocomplete requests. */
    tabId?: string;
    /** Host selected for a run that may not have a tab yet. */
    serverId?: string;
    /** Session whose changed files appear under "Open in this session". */
    sessionId?: string;
    /** Notified whenever the editor's plan/work/session references change. */
    onRefsChange?: (
      planRefs: PlanReference[],
      workRefs: WorkReference[],
      sessionRefs: SessionReference[],
    ) => void;
    /** Synchronous emptiness signal — lets callers gate
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
    /** Show push-to-talk for prose editors outside the main input bar. */
    mic?: boolean;
    /** Enable the voice shortcut even when the idle mic is hidden. */
    dictation?: boolean;
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
    tabId,
    serverId,
    sessionId,
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
    mic = false,
    dictation,
    maxHeight = 140,
    class: klass = "",
    menuPlacement = "up",
    useRelativeFilePaths = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const autocompleteScope = $derived(
    resolveAutocompleteScope(session, workingDirectory, tabId, serverId),
  );
  const referenceNavigation = createReferenceNavigation(session, {
    workingDirectory: () => workingDirectory,
    tabId: () => tabId,
  });

  let plainTextEditorEl: ReturnType<typeof PlainTextEditor> | null =
    $state(null);
  const autocompleteEditor: AutocompleteEditor = {
    textBeforeCursor: () => plainTextEditorEl?.textBeforeCursor() ?? "",
    cursorRect: () => plainTextEditorEl?.getCursorRect() ?? null,
    focus: () => plainTextEditorEl?.focus(),
    replaceTrigger: (pattern, replacement) =>
      plainTextEditorEl?.replaceTrigger(pattern, replacement) ?? false,
    insertReference: (token, pattern) =>
      plainTextEditorEl?.insertReference(token, pattern) ?? false,
    unwrapFileReferenceBeforeCursor: () =>
      plainTextEditorEl?.unwrapFileReferenceBeforeCursor() ?? false,
    extractTrackedReferences: () =>
      plainTextEditorEl?.extractReferences() ?? {
        planRefs: [],
        workRefs: [],
        sessionRefs: [],
      },
    isCaretAtStart: () => plainTextEditorEl?.isCaretAtStart() ?? false,
    isCaretAtLineEnd: () => plainTextEditorEl?.isCaretAtLineEnd() ?? true,
  };

  // The reference-autocomplete state machine is editor-neutral; this component
  // hosts its menu and connects it to the lightweight CodeMirror composer.
  const ac = new UnifiedAutocompleteController({
    readOnly: () => readOnly,
    tabId: () => autocompleteScope.tabId,
    serverId: () => autocompleteScope.serverId,
    sessionId: () => sessionId,
    workingDirectory: () => autocompleteScope.workingDirectory,
    useRelativeFilePaths: () => useRelativeFilePaths,
    provider: () => provider,
    includeSolusCommands: () => includeSolusCommands,
    pluginCommands: () => pluginCommands,
    onSolusCommand: () => onSolusCommand,
    onRefsChange: () => onRefsChange,
    session,
    planStore,
    getEditor: () => autocompleteEditor,
  });

  // The completion is drawn by the editor, not the menu, so it sits exactly
  // where the next typed character would go.
  $effect(() => {
    plainTextEditorEl?.setGhostCompletion(ac.open ? ac.ghost : "");
  });

  const decoratedSlashCommands = $derived([
    ...ac.commands.solus,
    ...ac.commands.codex,
    ...ac.commands.claudeCode,
    ...ac.commands.global,
    ...ac.commands.project,
  ].map((command) => command.command));

  // Emit refs parsed from the starting value once the editor mounts. setContent
  // fires no update event, so without this a caller editing an automation never
  // learns about the plan/work tokens already in the saved prompt.
  $effect(() => {
    if (plainTextEditorEl) untrack(() => ac.syncRefs());
  });

  // Synchronous per-keystroke channel: autocomplete triggers must track the
  // caret immediately. CodeMirror emits plain markdown synchronously, so there
  // is no serialization debounce in the typing path.
  function handleEditorInput() {
    if (readOnly) return;
    ac.handleEditorChange(autocompleteEditor.textBeforeCursor(), true);
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
    plainTextEditorEl?.focus();
  }
  export function setValueAndCursor(
    text: string,
    autoFocus = true,
    ensureTrailingParagraph = false,
  ) {
    plainTextEditorEl?.setValueAndCursor(
      text,
      autoFocus,
      ensureTrailingParagraph,
    );
    // Re-evaluate the trigger so prompt-history navigation keeps the menu in
    // sync (setContent fires no editor update).
    ac.handleEditorChange(
      untrack(() => autocompleteEditor.textBeforeCursor() || text),
    );
  }
  export function clearEditor() {
    plainTextEditorEl?.clearEditor();
    ac.clearCompletions();
  }
  export function insertTranscript(transcript: string) {
    plainTextEditorEl?.insertTranscript(transcript);
  }
  export function isCaretAtStart(): boolean {
    return autocompleteEditor.isCaretAtStart();
  }
</script>

{#if ac.open}
  <UnifiedAutocompleteMenu
    rows={ac.rows}
    triggerChar={ac.trigger!.char}
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

<PlainTextEditor
  bind:this={plainTextEditorEl}
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
  onPlanRefClick={onPlanRefClick ?? referenceNavigation.openPlan}
  onWorkRefClick={onWorkRefClick ?? referenceNavigation.openWork}
  onPrRefClick={onPrRefClick ?? referenceNavigation.openPr}
  onFileRefClick={onFileRefClick ?? referenceNavigation.openFile}
  {placeholder}
  ariaLabel="Message input"
  {disabled}
  {mic}
  {dictation}
  {maxHeight}
  referenceChips
  slashCommands={decoratedSlashCommands}
  class={klass}
/>
