<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import type { PlanReference, WorkReference } from "../../../../shared/types";
  import type { PromptComposerSubmit } from "./index";
  import { ArrowUpIcon, ChatCircleTextIcon, GitForkIcon, CaretDownIcon } from "phosphor-svelte";
  import PromptEditor from "../PromptEditor.svelte";
  import SessionChip from "../../pickers/SessionChip.svelte";
  import { Switch } from "../switch";
  import { modelOptionsFor, type PickerSelection } from "../../pickers/lib/picker-selection";
  import { getWorkspaceContext, getStatusBarContext, getAgentContext, getVoiceModelStore } from "../../../contexts";
  import { dictation, isDictationTarget } from "../../../lib/dictation.svelte";
  import { useKeybinding } from "../../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../../lib/keybindings/manifest";
  import WaveformVisualizer from "../../input/WaveformVisualizer.svelte";
  import RecordingControls from "../../input/RecordingControls.svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { uuid } from "../../../../shared/uuid";

  interface Props {
    /** Markdown draft (bindable). Tiptap won't re-render from an external
     *  `value = ''` — hosts reset through the exposed `clear()`. */
    value: string;
    placeholder?: string;
    /** Directory for @-file search, plan preload, and work loading. */
    workingDirectory?: string;
    /** Tab whose session seeds the picker selection; the active tab otherwise. */
    tabId?: string;
    showPicker?: boolean;
    /** Omit to render no send button — the host supplies actions via `trailing`
     *  and reads the composed state with `payload()`. */
    onSubmit?: (payload: PromptComposerSubmit) => void | Promise<void>;
    /** Queued inline comments / drafts can submit with an empty editor. */
    canSubmitWhenEmpty?: boolean;
    submitting?: boolean;
    disabled?: boolean;
    /** Whether autocomplete + picker menus grow upward or downward. */
    menuPlacement?: "up" | "down";
    /** Offers the collapse toggle that minimises the pill to a caret button. */
    collapsible?: boolean;
    /** Bindable so hosts can drive it from a keybinding and adapt the actions
     *  they put in `trailing` (nothing is unmounted — the editor is hidden, so
     *  the draft and its refs survive a collapse). */
    collapsed?: boolean;
    /** Show the isolated-worktree toggle in the action row. */
    showWorktree?: boolean;
    /** Bindable worktree choice, applied by the host at dispatch. */
    useWorktree?: boolean;
    /** Forwarded keydown not consumed by autocomplete or the ⌘↵ submit. */
    onKeyDown?: (e: KeyboardEvent) => void;
    /** Action row, directly after the model picker. */
    afterPicker?: Snippet;
    /** Action row, right of the spacer and before the send button. */
    trailing?: Snippet;
  }

  let {
    value = $bindable(),
    placeholder = "",
    workingDirectory,
    tabId,
    showPicker = true,
    onSubmit,
    canSubmitWhenEmpty = false,
    submitting = false,
    disabled = false,
    menuPlacement = "up",
    collapsible = true,
    collapsed = $bindable(false),
    showWorktree = false,
    useWorktree = $bindable(false),
    onKeyDown,
    afterPicker,
    trailing,
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const agentContext = getAgentContext();
  const voiceModel = getVoiceModelStore();

  // Local picker draft, seeded from the target session's effective config
  // (globalDefaults when no session exists yet). Applied by the host at
  // dispatch — never written back to the session from here.
  const seed = untrack(() => statusBar.ctxFor(tabId ?? session.activeTabId));
  let selection = $state<PickerSelection>({
    provider: seed.activeAgent,
    modelId: seed.model || null,
    reasoningEffort: seed.reasoningEffort,
  });
  // Panes outlive the tab they were opened for, so re-seed when the dispatch
  // target moves — otherwise a send applies the previous session's model.
  let seededFor = tabId ?? untrack(() => session.activeTabId);
  $effect(() => {
    const target = tabId ?? session.activeTabId;
    if (target === seededFor) return;
    seededFor = target;
    const ctx = untrack(() => statusBar.ctxFor(target));
    selection.provider = ctx.activeAgent;
    selection.modelId = ctx.model || null;
    selection.reasoningEffort = ctx.reasoningEffort;
  });

  const sess = $derived(session.sessionFor(tabId ?? session.activeTabId));
  const pluginCommands = $derived(sess?.pluginCommands ?? session.pluginCommands);
  // No models known for the provider (not even static profiles) — hide the chip.
  const pickerVisible = $derived(
    showPicker && modelOptionsFor(selection.provider, agentContext.metadata).length > 0,
  );

  let editorEl: ReturnType<typeof PromptEditor> | null = $state(null);
  let editorEmpty = $state(true);
  let planRefs = $state<PlanReference[]>([]);
  let workRefs = $state<WorkReference[]>([]);
  let focused = $state(false);

  const hasContent = $derived(!editorEmpty || canSubmitWhenEmpty);
  const canSend = $derived(hasContent && !submitting && !disabled);

  // ─── Voice dictation ───
  // Reuses the app-wide recorder in conversational mode, but routes the
  // transcript into this editor at the caret instead of sending it. autoRearm
  // returns false so each utterance is one push-to-talk capture.
  const voiceOwnerId = `prompt-composer:${untrack(uuid)}`;
  const ownsVoice = $derived(dictation.messageOwner === voiceOwnerId);
  const voiceState = $derived(
    ownsVoice && dictation.mode === "message" ? dictation.state : "idle",
  );
  const voiceReady = $derived(voiceModel.ready);
  const showWaveform = $derived(voiceState === "recording");
  let hasMountedWaveform = $state(false);
  $effect(() => {
    if (showWaveform) hasMountedWaveform = true;
  });

  function appendTranscript(transcript: string) {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    const base = value.trimEnd();
    const next = base ? `${base} ${trimmed}` : trimmed;
    editorEl?.setValueAndCursor(next, true, false);
    value = next;
  }
  function claimVoice() {
    dictation.claimMessageConsumer(voiceOwnerId, appendTranscript, () => false);
  }
  function toggleVoice() {
    if (!voiceReady || disabled) return;
    dictation.toggleConversationalFor(voiceOwnerId, appendTranscript, () => false);
  }
  onDestroy(() => dictation.releaseMessageConsumer(voiceOwnerId));

  useKeybinding("voice.toggle-recorder", toggleVoice, {
    enabled: () =>
      ownsVoice &&
      focused &&
      voiceReady &&
      !disabled &&
      !isDictationTarget(document.activeElement),
  });

  function handleSubmit() {
    if (!canSend || !onSubmit) return;
    void onSubmit(payload());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && onSubmit) {
      e.preventDefault();
      handleSubmit();
      return;
    }
    onKeyDown?.(e);
  }

  function handleCardFocusOut(event: FocusEvent & { currentTarget: HTMLDivElement }) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    // Hiding the Electron window blurs the editor with no next target. Keep the
    // card's focused presentation in that case so restoring the app does not
    // paint one unfocused frame before Chromium restores editor focus.
    if (next === null && !document.hasFocus()) return;
    focused = false;
  }

  // ─── Exposed host methods ───

  export function focus() {
    editorEl?.focus();
  }
  export function clear() {
    editorEl?.clearEditor();
    value = "";
    planRefs = [];
    workRefs = [];
  }
  /** Current composed state — for hosts that dispatch through their own buttons. */
  export function payload(): PromptComposerSubmit {
    return {
      text: value.trim(),
      provider: selection.provider,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
      planRefs: [...planRefs],
      workRefs: [...workRefs],
    };
  }
</script>

{#if collapsed}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    onclick={() => (collapsed = false)}
    aria-label="Expand composer"
    aria-expanded="false"
    class="pointer-events-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-(--solus-container-border) bg-(--solus-input-pill-bg) font-secondary text-(--solus-text-secondary) transition-[color,transform] duration-150 hover:text-(--solus-text-primary) active:scale-[0.96]"
  >
    <ChatCircleTextIcon size={14} weight="bold" />
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={"Expand"} />
  </TooltipUI.Root>
{/if}

<!-- The input bar's card, at the same measurements (see EditorInputCard): a
     hairline, nothing behind it, terracotta spent only on focus. Hidden rather
     than unmounted while collapsed, so the editor instance, the draft, and its
     plan/work refs all survive the round trip. -->
<div
  class="flex flex-col rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3 transition-[box-shadow] duration-[180ms] {focused
    ? 'shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)]'
    : 'shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]'}"
  style:display={collapsed ? "none" : null}
  onfocusin={() => (focused = true)}
  onfocusout={handleCardFocusOut}
>
  {#if hasMountedWaveform}
    <div class="flex items-center gap-2" style:display={showWaveform ? null : "none"} style="padding:0.5rem 0.25rem">
      <div class="min-w-0 flex-1">
        <WaveformVisualizer rmsRef={dictation.rmsRef} color="var(--solus-accent)" active={showWaveform} />
      </div>
    </div>
  {/if}
  <div class="px-1.5" style:display={showWaveform ? "none" : null}>
    <PromptEditor
      bind:this={editorEl}
      {value}
      onValueChange={(v) => (value = v)}
      onEmptyChange={(empty) => (editorEmpty = empty)}
      {pluginCommands}
      provider={selection.provider}
      {tabId}
      {workingDirectory}
      onRefsChange={(p, w) => {
        planRefs = p;
        workRefs = w;
      }}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        claimVoice();
      }}
      onPlanRefClick={(planId) => session.openPlanModal(planId)}
      onWorkRefClick={(workId, title) => session.openWorkModal(workId, title)}
      onPrRefClick={(number, title) =>
        void session.enterPrReview(number, title, {
          ctx: workingDirectory
            ? session.ctxForDirectory(workingDirectory)
            : session.ctx,
        })}
      {placeholder}
      {disabled}
      enterInsertsNewline
      {menuPlacement}
      maxHeight={260}
      class="[--plain-editor-font-size:var(--text-body)] [--plain-editor-padding:1.25rem_0_1.25rem_0]"
    />
  </div>
  <!-- Same geometry as the input bar's toolbar row (InputBar.svelte): the
       controls stay proportional to the composer text preference. -->
  <div
    class="flex items-center gap-2 w-full"
    style="zoom:var(--solus-font-scale,1)"
  >
    {#if collapsible}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button {...tooltipProps}
        type="button"
        onclick={() => (collapsed = true)}
        aria-label="Collapse composer"
        aria-expanded="true"
        class="flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
      >
        <CaretDownIcon size={14} weight="bold" />
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={"Collapse"} />
      </TooltipUI.Root>
    {/if}
    {#if pickerVisible}
      <SessionChip
        bind:selection
        menuSide={menuPlacement === "down" ? "bottom" : "top"}
        onReturnFocus={() => editorEl?.focus()}
      />
    {/if}
    {@render afterPicker?.()}
    {#if showWorktree}
      <label
        class="flex h-[1.875rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-1 text-sm font-medium transition-colors {useWorktree ? 'text-(--solus-accent)' : 'font-secondary text-(--solus-text-secondary)'}"
        title={useWorktree ? "Worktree enabled — run in an isolated branch (⌥W)" : "Enable worktree — run in an isolated branch (⌥W)"}
      >
        <GitForkIcon size={14} />
        Worktree
        <Switch size="sm" bind:checked={useWorktree} data-testid="composer-worktree" aria-label="Run in an isolated worktree" />
      </label>
    {/if}
    <div class="flex items-center gap-2 shrink-0 ml-auto">
      <RecordingControls
        variant="bar"
        state={voiceState}
        rmsRef={dictation.rmsRef}
        disabled={!voiceReady || disabled}
        progressPct={voiceReady ? null : voiceModel.progressPct}
        idleTooltip={voiceReady ? `Voice input (${comboHint("voice.toggle-recorder")})` : "Voice model is preparing"}
        onCancel={() => dictation.cancel()}
        onConfirm={() => dictation.stop()}
        onToggle={toggleVoice}
      />

      {@render trailing?.()}

      <!-- Like the input bar, the button holds its corner and goes neutral
           rather than disappearing: fill is spent on send, and only once there
           is something to send. -->
      {#if onSubmit}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          type="button"
          onclick={handleSubmit}
          disabled={!canSend}
          aria-label="Send"
          class="flex size-[1.875rem] shrink-0 items-center justify-center rounded-lg transition-[background-color,box-shadow,transform] duration-150 enabled:active:scale-[0.96] {canSend
            ? 'bg-(--solus-accent) text-(--solus-text-on-accent) shadow-[0_0.25rem_0.75rem_-0.375rem_var(--solus-send-glow)] hover:shadow-[0_0.3125rem_0.875rem_-0.375rem_var(--solus-send-glow)]'
            : 'cursor-default bg-(--solus-surface-active) text-(--solus-text-tertiary)'}"
        >
          <ArrowUpIcon size={14} weight="bold" />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={canSend ? "Send · ⌘↵" : null} />
        </TooltipUI.Root>
      {/if}
    </div>
  </div>
</div>
