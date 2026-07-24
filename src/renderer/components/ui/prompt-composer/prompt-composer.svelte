<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import type { PlanReference, WorkReference } from "../../../../shared/types";
  import type { PromptComposerSubmit } from "./index";
  import { ArrowUpIcon, MicrophoneIcon, SpinnerGapIcon, XIcon, CheckIcon, GitForkIcon, CaretDownIcon, CaretUpIcon } from "phosphor-svelte";
  import PromptEditor from "../PromptEditor.svelte";
  import SessionChip from "../../pickers/SessionChip.svelte";
  import { Switch } from "../switch";
  import { modelOptionsFor, type PickerSelection } from "../../pickers/lib/picker-selection";
  import { getWorkspaceContext, getStatusBarContext, getAgentContext, getVoiceModelStore } from "../../../contexts";
  import { dictation, isDictationTarget } from "../../../lib/dictation.svelte";
  import { useKeybinding } from "../../../lib/keybindings/use-keybinding.svelte";
  import WaveformVisualizer from "../../input/WaveformVisualizer.svelte";
  import { tooltip } from "../../../lib/tooltip";
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
    /** Only when the dispatch target is a new or reset session — the agent
     *  can't change mid-session. */
    allowAgentSwitch?: boolean;
    /** Omit to render no send button — the host supplies actions via `trailing`
     *  and reads the composed state with `payload()`. */
    onSubmit?: (payload: PromptComposerSubmit) => void | Promise<void>;
    /** Queued inline comments / drafts can submit with an empty editor. */
    canSubmitWhenEmpty?: boolean;
    submitting?: boolean;
    disabled?: boolean;
    /** Whether autocomplete + picker menus grow upward or downward. */
    menuPlacement?: "up" | "down";
    /** "lg" matches the main input bar's chrome — taller pill, 2.25rem controls,
     *  and the same 260px growth ceiling. "sm" is the dense in-panel pill. */
    size?: "sm" | "lg";
    /** Offers the collapse toggle that shrinks the pill to its action row. */
    collapsible?: boolean;
    /** Bindable so hosts can drive it from a keybinding and adapt the actions
     *  they put in `trailing` (nothing is unmounted — the editor is hidden, so
     *  the draft and its refs survive a collapse). */
    collapsed?: boolean;
    /** Show the isolated-worktree toggle in the action row (only meaningful when
     *  the dispatch target is a new/reset session — i.e. allowAgentSwitch). */
    showWorktree?: boolean;
    /** Bindable worktree choice, applied by the host at dispatch. */
    useWorktree?: boolean;
    /** Forwarded keydown not consumed by autocomplete or the ⌘↵ submit. */
    onKeyDown?: (e: KeyboardEvent) => void;
    /** Action row, left of the picker. */
    leading?: Snippet;
    /** Action row, right of the spacer and before the send button. */
    trailing?: Snippet;
  }

  let {
    value = $bindable(),
    placeholder = "",
    workingDirectory,
    tabId,
    showPicker = true,
    allowAgentSwitch = false,
    onSubmit,
    canSubmitWhenEmpty = false,
    submitting = false,
    disabled = false,
    menuPlacement = "up",
    size = "sm",
    collapsible = true,
    collapsed = $bindable(false),
    showWorktree = false,
    useWorktree = $bindable(false),
    onKeyDown,
    leading,
    trailing,
  }: Props = $props();

  // Size is real component state, so the chrome that scales with it reads from
  // one flag rather than being repeated per element.
  const lg = $derived(size === "lg");
  const ctrlBox = $derived(lg ? "size-9" : "size-6");
  const ctrlIcon = $derived(lg ? 16 : 12);
  const shellBox = $derived(
    lg
      ? "min-h-[5.5rem] rounded-[1.375rem] px-3.5 pt-1 pb-2"
      : "rounded-[1.25rem] px-2.5 py-2",
  );

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

  const canSend = $derived(
    (!editorEmpty || canSubmitWhenEmpty) && !submitting && !disabled,
  );

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
  <button
    type="button"
    onclick={() => (collapsed = false)}
    aria-label="Expand composer"
    aria-expanded="false"
    class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-(--solus-container-border) bg-(--solus-input-pill-bg) text-(--solus-text-secondary) transition-[color,transform] duration-150 hover:text-(--solus-text-primary) active:scale-[0.96]"
    use:tooltip={"Expand"}
  >
    <CaretUpIcon size={14} weight="bold" />
  </button>
{/if}

<!-- Hidden rather than unmounted while collapsed: the Tiptap instance, the
     draft, and its plan/work refs all survive the round trip. -->
<div
  class="flex flex-col border bg-(--solus-input-pill-bg) transition-[border-color,box-shadow] duration-150 {shellBox} {focused
    ? 'border-(--solus-input-focus-border) shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)]'
    : 'border-(--solus-container-border)'}"
  style:display={collapsed ? "none" : null}
>
  {#if hasMountedWaveform}
    <div class="flex items-center gap-2" style:display={showWaveform ? null : "none"} style="padding:0.5rem 0.25rem">
      <div class="min-w-0 flex-1">
        <WaveformVisualizer rmsRef={dictation.rmsRef} color="var(--solus-accent)" active={showWaveform} />
      </div>
    </div>
  {/if}
  <div style:display={showWaveform ? "none" : null}>
    <PromptEditor
      bind:this={editorEl}
      {value}
      onValueChange={(v) => (value = v)}
      onEmptyChange={(empty) => (editorEmpty = empty)}
      {pluginCommands}
      provider={selection.provider}
      {workingDirectory}
      onRefsChange={(p, w) => {
        planRefs = p;
        workRefs = w;
      }}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        focused = true;
        claimVoice();
      }}
      onBlur={() => (focused = false)}
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
      maxHeight={lg ? 260 : 110}
      class={lg ? "" : "pc-editor"}
    />
  </div>
  <div class="flex items-center gap-1">
    {#if collapsible}
      <button
        type="button"
        onclick={() => (collapsed = true)}
        aria-label="Collapse composer"
        aria-expanded="true"
        class="flex {ctrlBox} shrink-0 cursor-pointer items-center justify-center rounded-full text-(--solus-text-tertiary) transition-[background-color,color] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
        use:tooltip={"Collapse"}
      >
        <CaretDownIcon size={ctrlIcon} weight="bold" />
      </button>
    {/if}
    {@render leading?.()}
    {#if pickerVisible}
      <SessionChip bind:selection {allowAgentSwitch} dense={!lg} menuSide={menuPlacement === "down" ? "bottom" : "top"} />
    {/if}
    {#if showWorktree}
      <label
        class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-1 font-medium transition-colors {lg ? 'h-8 text-[0.8125rem]' : 'h-6 text-[0.75rem]'} {useWorktree ? 'text-(--solus-accent)' : 'text-(--solus-text-secondary)'}"
        title={useWorktree ? "Worktree enabled — run in an isolated branch (⌥W)" : "Enable worktree — run in an isolated branch (⌥W)"}
      >
        <GitForkIcon size={lg ? 15 : 13} />
        Worktree
        <Switch size="sm" bind:checked={useWorktree} data-testid="composer-worktree" aria-label="Run in an isolated worktree" />
      </label>
    {/if}
    <div class="min-w-0 flex-1"></div>

    {#if voiceState === "recording"}
      <button
        type="button"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => dictation.cancel()}
        aria-label="Cancel recording"
        class="flex {ctrlBox} shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--solus-surface-hover) text-(--solus-text-tertiary) transition-transform duration-150 active:scale-[0.96]"
        use:tooltip={"Cancel recording"}
      >
        <XIcon size={ctrlIcon} weight="bold" />
      </button>
      <button
        type="button"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => dictation.stop()}
        aria-label="Finish recording"
        class="flex {ctrlBox} shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--solus-accent) text-(--solus-text-on-accent) transition-transform duration-150 active:scale-[0.96]"
        use:tooltip={"Confirm recording"}
      >
        <CheckIcon size={ctrlIcon} weight="bold" />
      </button>
    {:else if voiceState === "transcribing"}
      <span class="flex {ctrlBox} shrink-0 items-center justify-center text-(--solus-mic-color)">
        <SpinnerGapIcon size={lg ? 16 : 13} class="animate-spin" />
      </span>
    {:else}
      <button
        type="button"
        onmousedown={(e) => e.preventDefault()}
        onclick={toggleVoice}
        disabled={!voiceReady || disabled}
        aria-label="Voice input"
        class="flex {ctrlBox} shrink-0 items-center justify-center rounded-full text-(--solus-mic-color) transition-[background-color,opacity] duration-150 enabled:cursor-pointer enabled:hover:bg-(--solus-mic-bg) disabled:opacity-40"
        use:tooltip={voiceReady ? "Voice input" : "Voice model is preparing"}
      >
        <MicrophoneIcon size={lg ? 16 : 13} />
      </button>
    {/if}

    {@render trailing?.()}

    {#if onSubmit}
      <button
        type="button"
        onclick={handleSubmit}
        disabled={!canSend}
        aria-label="Send"
        class="flex {ctrlBox} shrink-0 items-center justify-center rounded-full bg-[linear-gradient(145deg,#e08868_0%,#d97757_40%,#c96442_100%)] text-(--solus-text-on-accent) shadow-[0_0.0625rem_0.1875rem_var(--solus-send-glow)] transition-[box-shadow,transform,opacity] duration-150 hover:shadow-[0_0.125rem_0.375rem_var(--solus-send-glow)] active:scale-[0.96] disabled:active:scale-100"
        style="opacity:{canSend ? 1 : 0.4};cursor:{canSend ? 'pointer' : 'default'}"
        use:tooltip={"Send · ⌘↵"}
      >
        <ArrowUpIcon size={ctrlIcon} weight="bold" />
      </button>
    {/if}
  </div>
</div>
