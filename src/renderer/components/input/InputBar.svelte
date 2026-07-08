<script lang="ts">
  import { untrack } from "svelte";
  import { ArrowUpIcon, SquareIcon, XIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getStatusBarContext } from "../../contexts/status-bar.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getVoiceModelStore } from "../../contexts/voice-model.store.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import type { PlanReference, WorkReference } from "../../../shared/types";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import AttachmentChips from "./AttachmentChips.svelte";
  import { SLASH_COMMANDS, type SlashCommand } from "./slash-commands";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import WaveformVisualizer from "./WaveformVisualizer.svelte";
  import RecordingControls from "./RecordingControls.svelte";
  import { dictation, isDictationTarget } from "../../lib/dictation.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { FOCUS_INPUT_EVENT, requestInputFocus } from "../../lib/inputFocus";
  import { requestFilePreview } from "../../lib/filePreview";
  import { runtime } from "../../contexts/runtime.svelte";
  import { VoiceRetryTracker } from "./lib/voice-retry.svelte";

  const HISTORY_KEY = "solus-prompt-history";
  const MAX_HISTORY = 100;

  import type { Snippet } from "svelte";

  interface Props {
    mode?: "pill" | "editor";
    leadingActions?: Snippet;
  }
  let { mode = "pill", leadingActions }: Props = $props();

  const INPUT_MAX_HEIGHT = $derived(mode === "editor" ? 260 : 140);

  const theme = getSettingsContext();
  const voiceModel = getVoiceModelStore();
  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const windowCtx = getWindowContext();

  const sess = $derived(session.sessionFor(session.activeTabId));
  const activeTabId = $derived(session.activeTabId);
  const isActiveMode = $derived(mode === windowCtx.viewMode);
  const isMobile = $derived(runtime.isMobileViewport);
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isConnecting = $derived(sess?.status === "connecting");
  const isReadOnly = $derived(!!sess?.readOnlyReason);
  const attachments = $derived(session.currentInput.attachments);
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  const activeProvider = $derived(sess?.provider ?? theme.activeAgent);
  const pluginCommands = $derived(
    sess?.pluginCommands ?? session.pluginCommands,
  );
  // Working directory driving @-file search and plan/work lookup in the composer.
  const composerCwd = $derived(
    sess?.workingDirectory ?? statusBar.ctx.workingDirectory,
  );

  // ─── Prompt history ───

  function loadHistory(): string[] {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }
  let promptHistory = $state<string[]>(loadHistory());
  let historyIndex = $state(-1);
  let savedInput = "";

  function savePromptToHistory(prompt: string) {
    if (!prompt || promptHistory[promptHistory.length - 1] === prompt) return;

    promptHistory.push(prompt);
    if (promptHistory.length > MAX_HISTORY) promptHistory.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(promptHistory));
  }

  function resetHistoryNavigation() {
    historyIndex = -1;
    savedInput = "";
  }

  // ─── Editor state ───

  // The composer text lives on the active tab's input state (or the tab-less
  // one). Switching tabs swaps `currentInput`, so the editor follows along with
  // no manual save/restore — see MarkdownEditor's reactive `value` sync.
  const inputText = $derived(session.currentInput.text);

  // When this bar is inactive (hidden with display:none) the underlying TipTap
  // instance is still alive. Without a guard it calls setContent on every
  // keystroke — parsing markdown and dispatching ProseMirror transactions for
  // a hidden editor. Freeze the draft at the moment this bar goes inactive;
  // switch back to the live reactive value the instant it becomes active again.
  let frozenText = $state(untrack(() => session.currentInput.text));
  $effect(() => {
    if (!isActiveMode) frozenText = untrack(() => session.currentInput.text);
  });
  const editorValue = $derived(isActiveMode ? session.currentInput.text : frozenText);
  let composerEl: ReturnType<typeof PromptEditor> | null = $state(null);

  // Skill commands, used only to strip a mobile-autocorrect duplication on send.
  const providerSkills = $derived(
    [...pluginCommands.project, ...pluginCommands.global].filter(
      (command) => command.kind === "skill",
    ),
  );

  // ─── Voice recorder ───

  // The app-wide voice controller owns the single recorder, shared with plain
  // fields' dictation. This bar drives its conversational ('message') mode.
  const voice = dictation;
  const voiceRetry = new VoiceRetryTracker();
  let retryClock = $state(Date.now());

  // The recorder is shared, so gate this bar's voice UI on conversational mode:
  // a plain field dictating elsewhere must not light up the input bar.
  const voiceState = $derived(voice.mode === "message" ? voice.state : "idle");

  // Lazy-mount the waveform: once true, never resets so the canvas stays alive.
  let hasMountedWaveform = $state(false);
  $effect(() => {
    if (voiceState === "recording") hasMountedWaveform = true;
  });

  // Pure derived — no timers. Covers the full recording→transcribing→idle→
  // recording cycle without flickering because the Dictation layer re-arms
  // synchronously in onIdle (setting voice.starting=true in the same microtask
  // as the idle transition, before any Svelte render).
  const showWaveform = $derived(
    voiceState === "recording" ||
      (voiceState === "transcribing" && voiceModeEnabled) ||
      (voiceState === "idle" && voiceModeEnabled && voice.starting),
  );
  const stableVoiceState = $derived<"idle" | "recording" | "transcribing">(
    showWaveform ? "recording" : voiceState,
  );

  // Register the conversational transcript→send handler and auto-rearm callback
  // while this bar is the active mode. The inactive (pill/editor) instance
  // leaves them untouched, so the stored handlers always belong to whichever
  // bar is visible.
  $effect(() => {
    if (!isActiveMode) return;
    voice.setMessageHandler((transcript) => {
      const prompt = transcript.trim();
      if (!prompt || isConnecting || isReadOnly) return;
      sendPrompt(prompt, { refocus: false });
    });
    voice.setAutoRearm(() => canAutoStart());
    return () => voice.setAutoRearm(null);
  });

  // ─── Derived state ───

  const hasContent = $derived(
    inputText.trim().length > 0 ||
      attachments.length > 0 ||
      planRefs.length > 0 ||
      workRefs.length > 0,
  );
  const canSend = $derived(!isConnecting && !isReadOnly && hasContent);
  const planRefs = $derived(session.currentInput.planRefs);
  const workRefs = $derived(session.currentInput.workRefs);
  // Work this session is actively collaborating on — its content is injected
  // into each prompt so the agent revises the live version.
  const boundWork = $derived(
    sess?.boundWorkId ? session.worksStore.get(sess.boundWorkId) : null,
  );
  function unbindWork() {
    if (sess) sess.boundWorkId = null;
    composerEl?.focus();
  }
  // Task this session was started from — its hydrated ticket was injected at
  // session start. The title comes from the tasks store when it's loaded for
  // this project; otherwise we fall back to the bare id.
  const boundTask = $derived(
    sess?.boundTaskId
      ? (session.tasksStore.tasks.find((t) => t.id === sess.boundTaskId) ?? null)
      : null,
  );
  function unbindTask() {
    if (sess) sess.boundTaskId = null;
    composerEl?.focus();
  }
  const isVoiceWaiting = $derived(
    voiceModeEnabled && voiceModel.ready && isBusy && !isReadOnly && voiceState === "idle",
  );
  const voiceModelTooltip = $derived.by(() => {
    if (voiceModel.ready) return null;
    if (voiceModel.status.state === "downloading" && voiceModel.progressPct !== null) {
      return `Downloading voice model - ${voiceModel.progressPct}%`;
    }
    if (voiceModel.status.state === "error") return "Voice model failed to download - retry in Settings";
    return "Voice model is preparing";
  });
  const voicePausedTooltip = $derived.by(() => {
    if (!voice.error) return null;
    if (voice.errorKind === "transient" && voiceRetry.exhausted) return `Voice paused: ${voice.error}`;
    if (voice.errorKind && voice.errorKind !== "transient") return `Voice paused: ${voice.error}`;
    return null;
  });
  const idleVoiceTooltip = $derived(
    isReadOnly
      ? "Read-only session"
      : (voiceModelTooltip ?? voicePausedTooltip ?? (isVoiceWaiting ? "Voice mode waiting..." : "Voice input")),
  );
  const placeholder = $derived(
    isReadOnly
      ? (sess?.readOnlyReason ?? "This session is read-only.")
      : isConnecting
        ? "Initializing..."
        : voiceState === "transcribing"
          ? "Transcribing..."
          : isBusy
            ? voiceModeEnabled
              ? "Waiting for Claude..."
              : "Type to queue a message..."
            : activeProvider === "codex"
              ? "Ask Codex anything..."
              : "Ask Claude Code anything...",
  );

  // ─── Focus management ───

  let prevFocusable = untrack(() => isActiveMode && !session.sessionPickerOpen);
  $effect(() => {
    void sess?.workingDirectory;
    void sess?.readOnlyReason;
    const isFocusable = isActiveMode && !session.sessionPickerOpen;
    const justBecameFocusable = isFocusable && !prevFocusable;
    prevFocusable = isFocusable;

    if (!isFocusable || isReadOnly || runtime.shouldSuppressFocus) return;

    if (justBecameFocusable) {
      // rAF ensures focus lands after display:none → visible transitions
      requestAnimationFrame(() => {
        if (isActiveMode && !session.sessionPickerOpen && !isReadOnly) {
          composerEl?.focus();
        }
      });
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      active !== document.body &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    ) {
      return;
    }
    composerEl?.focus();
  });

  // "Quote in reply": main sends the selected conversation text when the user
  // picks it from the native right-click menu. Prepend it as a markdown
  // blockquote so they can type their message addressing that snippet. Only the
  // active-mode bar subscribes (both pill+editor instances stay mounted).
  function insertQuote(text: string) {
    const snippet = text.trim();
    if (!snippet) return;
    const quoted = snippet
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const existing = session.currentInput.text;
    const next = existing.trim()
      ? `${existing}\n\n${quoted}\n\n`
      : `${quoted}\n\n`;
    session.currentInput.text = next;
    composerEl?.setValueAndCursor(next, true, true);
    requestInputFocus();
  }

  $effect(() => {
    if (!isActiveMode) return;
    return window.solus.onQuoteSelection((text) => {
      if (isReadOnly) return;
      insertQuote(text);
    });
  });

  $effect(() => {
    const p = session.pendingInput;
    if (!p) return;
    if (isReadOnly) {
      session.update({ pendingInput: null });
      return;
    }
    session.currentInput.text = p;
    session.update({ pendingInput: null });
    requestInputFocus();
  });

  $effect(() => {
    const handleFocusRequest = () => {
      if (!isActiveMode || session.sessionPickerOpen || isReadOnly) return;
      requestAnimationFrame(() => {
        if (isActiveMode && !session.sessionPickerOpen && !isReadOnly) {
          composerEl?.focus();
        }
      });
    };
    window.addEventListener(FOCUS_INPUT_EVENT, handleFocusRequest);
    return () =>
      window.removeEventListener(FOCUS_INPUT_EVENT, handleFocusRequest);
  });

  // ─── Voice mode effects ───

  // Conditions under which conversational voice mode may (re)arm the mic. Note
  // there is NO `isBusy` gate: voice stays live while Claude is running so the
  // user can keep dictating follow-ups, which queue as messages. We yield the
  // mic whenever a plain-input field owns dictation (dictation.focusedTarget).
  function canAutoStart(): boolean {
    const errorAllowsStart =
      voice.errorKind === null ||
      (voice.errorKind === "transient" && voiceRetry.canRetry(retryClock));
    return (
      voiceModeEnabled &&
      voiceModel.ready &&
      isActiveMode &&
      windowCtx.visible &&
      !isReadOnly &&
      errorAllowsStart &&
      voice.state === "idle" &&
      inputText.trim().length === 0 &&
      dictation.focusedTarget === null
    );
  }

  let prevVoiceErrorKind = untrack(() => voice.errorKind);
  $effect(() => {
    const kind = voice.errorKind;
    if (kind === prevVoiceErrorKind) return;
    prevVoiceErrorKind = kind;
    if (kind === null) voiceRetry.reset();
    else voiceRetry.note(kind);
  });

  $effect(() => {
    const nextRetryAt = voiceRetry.nextRetryAt;
    if (!nextRetryAt) return;
    const delayMs = Math.max(0, nextRetryAt - Date.now());
    const timer = window.setTimeout(() => {
      retryClock = Date.now();
    }, delayMs);
    return () => window.clearTimeout(timer);
  });

  $effect(() => {
    // Only the active bar cancels; the inactive instance must not touch the
    // shared recorder — it would immediately kill the active bar's recording.
    if (isActiveMode && isReadOnly && voiceState === "recording")
      voice.cancel();
    if (isReadOnly) composerEl?.clearCompletions();
  });

  $effect(() => {
    const unsub = window.solus.onWindowShown(() => {
      if (!isActiveMode) return;
      if (!session.sessionPickerOpen && !isReadOnly) {
        requestInputFocus();
      }
    });
    return unsub;
  });

  $effect(() => {
    const unsub = window.solus.onWindowHidden(() => {
      if (isActiveMode && voiceState === "recording") voice.cancel();
    });
    return unsub;
  });

  // Single source of truth for (re)arming the recorder. Fires on any rising
  // edge that should resume listening: voice mode enabled, window shown, a turn
  // finishing, or a transcript completing (transcribing → idle) so the next
  // utterance can be queued even mid-turn. A user cancel goes recording → idle
  // (never through "transcribing"), so it does NOT re-arm — that's the escape
  // hatch to type instead of talk.
  let prevVoiceMode = untrack(() => voiceModeEnabled);
  let prevVisible = untrack(() => windowCtx.visible);
  let prevIsBusy = untrack(() => isBusy);
  let prevVoiceState = untrack(() => voiceState);
  let prevDictationFocus = untrack(() => dictation.focusedTarget);
  let prevVoiceModelReady = untrack(() => voiceModel.ready);
  $effect(() => {
    const enabled = voiceModeEnabled;
    const visible = windowCtx.visible;
    const busy = isBusy;
    const vstate = voiceState;
    const dictationFocus = dictation.focusedTarget;
    const modelReady = voiceModel.ready;
    const retryReady = voice.errorKind === "transient" && voiceRetry.canRetry(retryClock);

    if (prevVoiceMode && !enabled && vstate === "recording") voice.cancel();
    if (!prevVoiceMode && enabled) {
      voiceRetry.reset();
      voice.clearError();
    }

    const shouldArm =
      (enabled && !prevVoiceMode) ||
      (visible && !prevVisible) ||
      (prevIsBusy && !busy) ||
      (!prevVoiceModelReady && modelReady) ||
      retryReady ||
      (prevVoiceState === "transcribing" && vstate === "idle") ||
      (prevDictationFocus !== null && dictationFocus === null); // plain field released the mic

    prevVoiceMode = enabled;
    prevVisible = visible;
    prevIsBusy = busy;
    prevVoiceState = vstate;
    prevDictationFocus = dictationFocus;
    prevVoiceModelReady = modelReady;

    if (shouldArm && canAutoStart()) voice.startConversational();
  });

  useKeybinding(
    "voice.toggle-mode",
    () => theme.update({ voiceModeEnabled: !theme.voiceModeEnabled }),
    {
      enabled: () => isActiveMode && !isReadOnly,
    },
  );
  useKeybinding("voice.toggle-recorder", () => voice.toggleConversational(), {
    enabled: () =>
      isActiveMode && !isReadOnly && !isDictationTarget(document.activeElement),
  });
  // ─── Reference composer wiring ───

  function previewFile(path: string) {
    requestFilePreview({ path, tabId: activeTabId });
  }

  /** Keep the active tab's plan/work refs in sync with the editor's tokens. */
  function handleRefsChange(
    nextPlanRefs: PlanReference[],
    nextWorkRefs: WorkReference[],
  ) {
    const input = session.currentInput;
    // Avoid needless reassignment (and the derived churn it triggers) when both
    // the editor and the stored refs are empty — the common typing case.
    if (nextPlanRefs.length || input.planRefs.length)
      input.planRefs = nextPlanRefs;
    if (nextWorkRefs.length || input.workRefs.length)
      input.workRefs = nextWorkRefs;
  }

  function solusCommandFromInput(
    value: string,
  ): { cmd: SlashCommand; argument: string } | null {
    for (const cmd of SLASH_COMMANDS) {
      if (!value.startsWith(cmd.command)) continue;
      const rest = value.slice(cmd.command.length);
      if (rest && !/^[ \t\n]/.test(rest)) continue;
      return { cmd, argument: rest ? rest.slice(1) : "" };
    }
    return null;
  }

  function executeCommand(cmd: SlashCommand, argument = "") {
    if (isReadOnly && !cmd.allowReadOnly) return;
    void cmd.run?.({
      argument,
      ipcContext: session.ctx,
      clearTab: () => session.clearTab(),
      addSystemMessage: (message) => session.addSystemMessage(message),
      appendGlobalInstructions: (text) => {
        const existing = theme.extraInstructions.trim();
        theme.update({
          extraInstructions: existing ? `${existing}\n\n${text}` : text,
        });
      },
      requestInputFocus,
    });
  }

  // A Solus built-in command was picked from the menu. The composer has already
  // cleared its completion state; here we either insert its template text or run
  // it outright.
  function handleSolusCommand(cmd: SlashCommand) {
    if (isReadOnly) return;
    if (cmd.insertTextOnSelect) {
      const text = cmd.insertTextOnSelect;
      session.currentInput.text = text;
      composerEl?.setValueAndCursor(text);
      requestInputFocus();
      return;
    }
    session.currentInput.text = "";
    composerEl?.clearEditor();
    executeCommand(cmd);
  }

  // ─── Core input handlers ───

  function sendPrompt(prompt: string, options: { refocus?: boolean } = {}) {
    savePromptToHistory(prompt);
    session.currentInput.text = "";
    resetHistoryNavigation();
    composerEl?.clearEditor();
    if (mode === "pill") {
      session.isExpanded = true;
    }
    session.sendMessage(prompt || "See attached files");

    if (options.refocus !== false) {
      requestInputFocus();
    }
  }

  function handleSend() {
    if (isReadOnly) return;
    let prompt = inputText.trim();
    if (
      !prompt &&
      attachments.length === 0 &&
      planRefs.length === 0 &&
      workRefs.length === 0
    )
      return;
    if (isConnecting) return;

    // Mobile keyboards sometimes autocorrect the skill name and insert it as
    // plain text before the slash command (e.g. "ui /ui rest"). Strip it.
    for (const skill of providerSkills) {
      const prefix = skill.name + " /" + skill.name;
      if (prompt.startsWith(prefix)) {
        prompt = prompt.slice(skill.name.length + 1);
        break;
      }
    }

    const solusCommand = solusCommandFromInput(inputText);
    if (solusCommand) {
      session.currentInput.text = "";
      composerEl?.clearEditor();
      executeCommand(solusCommand.cmd, solusCommand.argument);
      requestInputFocus();
      return;
    }

    sendPrompt(prompt);
  }

  function navigateHistory(delta: -1 | 1) {
    if (delta === -1) {
      if (historyIndex === -1) {
        savedInput = inputText;
        historyIndex = promptHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      }
    } else {
      if (historyIndex < promptHistory.length - 1) {
        historyIndex++;
      } else {
        historyIndex = -1;
      }
    }
    const next = historyIndex >= 0 ? promptHistory[historyIndex] : savedInput;
    session.currentInput.text = next;
    composerEl?.setValueAndCursor(next);
  }

  // Fired by the composer only when no autocomplete menu consumed the event.
  function handleKeyDown(e: KeyboardEvent) {
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const atStart = composerEl?.isCaretAtStart() ?? false;
      if ((atStart || historyIndex !== -1) && promptHistory.length > 0) {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
    }

    if (e.key === "ArrowDown" && historyIndex !== -1) {
      e.preventDefault();
      navigateHistory(1);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleEditorChange(md: string) {
    if (isReadOnly) return;
    session.currentInput.text = md;
    if (historyIndex !== -1) resetHistoryNavigation();
  }

  async function handlePaste(e: ClipboardEvent) {
    if (isReadOnly) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const attachment = await window.solus.pasteImage(dataUrl);
          if (attachment) session.addAttachments([attachment]);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }

  function handleInterrupt() {
    session.interruptTab(activeTabId);
    window.solus.stopTab(session.ctxFor(activeTabId));
    requestInputFocus();
  }
</script>

<div class="flex flex-col w-full relative" style="contain:layout paint">
  {#if boundWork}
    <div class="flex pt-1.5">
      <div
        class="inline-flex items-center gap-1.5 rounded-lg bg-(--solus-accent-light) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent) max-w-full"
        data-testid="bound-work-chip"
      >
        <span class="opacity-70 shrink-0">Working on:</span>
        <span class="truncate">{boundWork.title}</span>
        <button
          type="button"
          class="shrink-0 flex items-center justify-center rounded hover:bg-(--solus-accent-border) -mr-0.5 p-0.5"
          onclick={unbindWork}
          aria-label="Stop working on this work"
          title="Unbind"
        >
          <XIcon size={11} />
        </button>
      </div>
    </div>
  {/if}

  {#if sess?.boundTaskId}
    <div class="flex pt-1.5">
      <div
        class="inline-flex items-center gap-1.5 rounded-lg bg-(--solus-accent-light) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent) max-w-full"
        data-testid="bound-task-chip"
      >
        <span class="opacity-70 shrink-0">Working on:</span>
        <span class="truncate">{boundTask?.title ?? `#${sess.boundTaskId}`}</span>
        <button
          type="button"
          class="shrink-0 flex items-center justify-center rounded hover:bg-(--solus-accent-border) -mr-0.5 p-0.5"
          onclick={unbindTask}
          aria-label="Stop working on this task"
          title="Unbind"
        >
          <XIcon size={11} />
        </button>
      </div>
    </div>
  {/if}

  {#if attachments.length > 0}
    <div style="padding-top:0.375rem;margin-left:-0.25rem">
      <AttachmentChips
        {attachments}
        onRemove={(id) => session.removeAttachment(id)}
      />
    </div>
  {/if}

  {#if leadingActions}
    <div class="flex flex-col w-full">
      <div class="min-w-0">
        {@render editorOrWaveform()}
      </div>
      <div class="flex items-center w-full" style="padding-top:0.125rem">
        {@render leadingActions()}
        <div
          class="flex items-center gap-1 shrink-0 ml-auto"
          style="padding-bottom:0.125rem"
        >
          {#if isMobile && isBusy}
            {@render stopButton()}
          {:else}
            {@render voiceButtons()}
            {@render sendButton()}
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="flex items-end w-full gap-2">
      <div class="flex-1 min-w-0">
        {@render editorOrWaveform()}
      </div>
      <div
        class="flex items-center gap-1 shrink-0 {isMobile
          ? 'pb-[0.125rem]'
          : 'pb-[0.375rem]'}"
      >
        {#if isMobile && isBusy}
          {@render stopButton()}
        {:else}
          {@render voiceButtons()}
          {@render sendButton()}
        {/if}
      </div>
    </div>
  {/if}

  {#if voice.error}
    <div class="px-1 pb-2 text-[0.6875rem] text-(--solus-status-error)">
      {voice.error}
    </div>
  {/if}
</div>

{#snippet editorOrWaveform()}
  {#if hasMountedWaveform}
    <div style="padding:0.75rem 0" style:display={showWaveform ? null : "none"}>
      {#if voice.partialText}
        <div class="overflow-hidden text-ellipsis whitespace-nowrap text-left text-[0.8125rem] text-(--solus-accent) [direction:rtl]">
          {voice.partialText}
        </div>
      {:else}
        <WaveformVisualizer
          rmsRef={voice.rmsRef}
          color="var(--solus-accent)"
          active={showWaveform}
        />
      {/if}
    </div>
  {/if}
  <div style:display={showWaveform ? "none" : null}>
    <PromptEditor
      bind:this={composerEl}
      value={editorValue}
      onValueChange={handleEditorChange}
      {pluginCommands}
      provider={activeProvider}
      workingDirectory={composerCwd}
      onRefsChange={handleRefsChange}
      includeSolusCommands
      onSolusCommand={handleSolusCommand}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onPlanRefClick={(planId) => session.openPlanModal(planId)}
      onWorkRefClick={(workId, title) => session.openWorkModal(workId, title)}
      onFileRefClick={previewFile}
      {placeholder}
      readOnly={isReadOnly}
      disabled={isReadOnly || isConnecting || voiceState === "transcribing"}
      maxHeight={INPUT_MAX_HEIGHT}
    />
  </div>
{/snippet}

{#snippet sendButton()}
  {#if canSend && !showWaveform}
    <button
      onclick={handleSend}
      data-testid="send-button"
      class="w-9 h-9 rounded-full flex items-center justify-center text-(--solus-text-on-accent) bg-[linear-gradient(145deg,#e08868_0%,#d97757_40%,#c96442_100%)] shadow-[0_0.125rem_0.5rem_var(--solus-send-glow),0_0.0625rem_0.125rem_rgba(0,0,0,0.2)] transition-[box-shadow,transform] duration-150 active:scale-[0.94] hover:shadow-[0_0.1875rem_0.75rem_var(--solus-send-glow),0_0.0625rem_0.1875rem_rgba(0,0,0,0.25)]"
      use:tooltip={isBusy ? "Queue message" : "Send (Enter)"}
    >
      <ArrowUpIcon size={16} weight="bold" />
    </button>
  {/if}
{/snippet}

{#snippet stopButton()}
  <button
    onmousedown={(e) => e.preventDefault()}
    onclick={handleInterrupt}
    data-testid="mobile-stop-button"
    class="w-9 h-9 rounded-full flex items-center justify-center text-(--solus-text-on-accent) bg-(--solus-stop-bg) shadow-[0_0.125rem_0.5rem_rgba(239,68,68,0.24),0_0.0625rem_0.125rem_rgba(0,0,0,0.2)] transition-[box-shadow,transform,background] duration-150 active:scale-[0.94] hover:bg-(--solus-stop-hover)"
    aria-label="Stop current task"
    use:tooltip={"Stop current task"}
  >
    <SquareIcon size={11} weight="fill" />
  </button>
{/snippet}

{#snippet voiceButtons()}
  <RecordingControls
    variant="bar"
    state={stableVoiceState}
    rmsRef={voice.rmsRef}
    waiting={isVoiceWaiting}
    disabled={isConnecting || isReadOnly || !voiceModel.ready}
    progressPct={!voiceModel.ready ? voiceModel.progressPct : null}
    partialText={voice.partialText}
    idleTooltip={idleVoiceTooltip}
    onCancel={() => voice.cancel()}
    onConfirm={() => voice.stop()}
    onToggle={() => voice.toggleConversational()}
  />
{/snippet}
