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
    tabId?: string;
    leadingActions?: Snippet;
  }
  let { mode = "pill", tabId, leadingActions }: Props = $props();

  const isPrimary = $derived(tabId === undefined);

  const INPUT_MAX_HEIGHT = $derived(mode === "editor" ? 260 : 140);

  const theme = getSettingsContext();
  const voiceModel = getVoiceModelStore();
  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const windowCtx = getWindowContext();
  const panes = session.panes;

  const targetTabId = $derived(tabId ?? session.activeTabId);
  const isFocusedPaneComposer = $derived(
    (isPrimary && panes.focusedPane === "primary") ||
      (!isPrimary &&
        panes.focusedPane === "secondary" &&
        tabId === panes.chatTabIn("secondary", session.activeTabId)),
  );
  const receivesFocusedInput = $derived(
    isFocusedPaneComposer ||
      (isPrimary && session.focusedChatTabId === null),
  );
  const sess = $derived(session.sessionFor(targetTabId));
  const input = $derived(session.inputFor(targetTabId));
  const isActiveMode = $derived(mode === windowCtx.viewMode);
  const isMobile = $derived(runtime.isMobileViewport);
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isConnecting = $derived(sess?.status === "connecting");
  const isReadOnly = $derived(!!sess?.readOnlyReason);
  const attachments = $derived(input.attachments);
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  const activeProvider = $derived(sess?.provider ?? theme.activeAgent);
  const pluginCommands = $derived(
    sess?.pluginCommands ?? session.pluginCommands,
  );
  // Working directory driving @-file search and plan/work lookup in the composer.
  const composerCwd = $derived(
    sess?.workingDirectory ?? statusBar.ctxFor(targetTabId).workingDirectory,
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

  // The composer text lives on the target tab's input state (the active tab's,
  // the pinned split tab's, or the tab-less one). Switching tabs swaps `input`,
  // so the editor follows along with no manual save/restore — see
  // MarkdownEditor's reactive `value` sync.
  const inputText = $derived(input.text);

  // When this bar is inactive (hidden with display:none) the underlying TipTap
  // instance is still alive. Without a guard it calls setContent on every
  // keystroke — parsing markdown and dispatching ProseMirror transactions for
  // a hidden editor. Freeze the draft at the moment this bar goes inactive;
  // switch back to the live reactive value the instant it becomes active again.
  let frozenText = $state(untrack(() => input.text));
  $effect(() => {
    if (!isActiveMode) frozenText = untrack(() => input.text);
  });
  const editorValue = $derived(isActiveMode ? input.text : frozenText);
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
  // a plain field dictating elsewhere must not light up the input bar. Primary
  // and split composers claim ownership on focus so transcripts land in the
  // draft the user is actually working in.
  const voiceOwnerId = $derived(`input-bar:${mode}:${tabId ?? "primary"}`);
  const ownsVoice = $derived(voice.messageOwner === voiceOwnerId);
  const voiceState = $derived(
    ownsVoice && voice.mode === "message" ? voice.state : "idle",
  );

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
  const voiceControlState = $derived<"idle" | "recording" | "transcribing">(
    voice.starting && showWaveform ? "recording" : voiceState,
  );

  function handleVoiceTranscript(transcript: string) {
    const prompt = transcript.trim();
    if (!prompt || isConnecting || isReadOnly) return;
    if (theme.autoSendVoiceTranscripts) {
      sendPrompt(prompt, { refocus: false });
    } else {
      const existing = input.text;
      const next = existing.trim() ? `${existing} ${prompt}` : prompt;
      input.text = next;
      composerEl?.setValueAndCursor(next, true, true);
    }
  }

  function claimVoice(startIfEnabled = false) {
    if (!isActiveMode || isReadOnly) return;
    const claimed = voice.claimMessageConsumer(
      voiceOwnerId,
      handleVoiceTranscript,
      () => canAutoStart(),
    );
    if (claimed && startIfEnabled && canAutoStart()) voice.startConversational();
  }

  function toggleVoice() {
    voice.toggleConversationalFor(
      voiceOwnerId,
      handleVoiceTranscript,
      () => canAutoStart(),
    );
  }

  // The visible primary composer is the default owner. A split composer takes
  // over when the user focuses or activates its controls.
  $effect(() => {
    if (!isActiveMode) return;
    const ownerId = voiceOwnerId;
    // Claiming reads recorder state to decide whether auto-start is allowed.
    // Keep those reads out of this ownership effect: otherwise starting the
    // recorder reruns the effect, whose cleanup immediately cancels it.
    if (isPrimary) untrack(() => claimVoice(true));
    return () => voice.releaseMessageConsumer(ownerId);
  });

  // ─── Derived state ───

  // Editor emptiness, updated synchronously by MarkdownEditor on every
  // keystroke — unlike `inputText`, which only reflects the 200ms-debounced
  // markdown emit. Seeding from `inputText` at mount/tab-switch is safe
  // because PromptEditor immediately reports the true state once its `value`
  // prop lands.
  let editorHasText = $state(untrack(() => inputText.trim().length > 0));
  const hasContent = $derived(
    editorHasText ||
      attachments.length > 0 ||
      planRefs.length > 0 ||
      workRefs.length > 0,
  );
  const canSend = $derived(!isConnecting && !isReadOnly && hasContent);
  const planRefs = $derived(input.planRefs);
  const workRefs = $derived(input.workRefs);
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
      ? (session.tasksStore.tasks.find((t) => t.id === sess.boundTaskId) ??
          null)
      : null,
  );
  function unbindTask() {
    if (sess) sess.boundTaskId = null;
    composerEl?.focus();
  }
  const isVoiceWaiting = $derived(
    voiceModeEnabled &&
      ownsVoice &&
      voiceModel.ready &&
      isBusy &&
      !isReadOnly &&
      voiceState === "idle",
  );
  const voiceModelTooltip = $derived.by(() => {
    if (voiceModel.ready) return null;
    if (
      voiceModel.status.state === "downloading" &&
      voiceModel.progressPct !== null
    ) {
      return `Downloading voice model - ${voiceModel.progressPct}%`;
    }
    if (voiceModel.status.state === "error")
      return "Voice model failed to download - retry in Settings";
    return "Voice model is preparing";
  });
  const voicePausedTooltip = $derived.by(() => {
    if (!voice.error) return null;
    if (voice.errorKind === "transient" && voiceRetry.exhausted)
      return `Voice paused: ${voice.error}`;
    if (voice.errorKind && voice.errorKind !== "transient")
      return `Voice paused: ${voice.error}`;
    return null;
  });
  const idleVoiceTooltip = $derived(
    isReadOnly
      ? "Read-only session"
      : (voiceModelTooltip ??
          voicePausedTooltip ??
          (isVoiceWaiting ? "Voice mode waiting..." : "Voice input")),
  );
  const placeholder = $derived(
    isReadOnly
      ? (sess?.readOnlyReason ?? "This session is read-only.")
      : isConnecting
        ? "Initializing..."
        : voiceState === "transcribing"
          ? "Transcribing..."
          : isBusy
            ? voiceModeEnabled && ownsVoice
              ? "Waiting for Claude..."
              : "Type to queue a message..."
            : "Plan, Build, Automate / @ for context",
  );

  // ─── Focus management ───

  function refocusComposer() {
    if (isPrimary) requestInputFocus();
    else composerEl?.focus();
  }

  let prevFocusable = untrack(() => isActiveMode && !session.sessionPickerOpen);
  $effect(() => {
    if (!isPrimary) return;
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
    const existing = input.text;
    const next = existing.trim()
      ? `${existing}\n\n${quoted}\n\n`
      : `${quoted}\n\n`;
    input.text = next;
    composerEl?.setValueAndCursor(next, true, true);
    requestInputFocus();
  }

  $effect(() => {
    if (!isActiveMode || !receivesFocusedInput) return;
    return window.solus.onQuoteSelection((text) => {
      if (isReadOnly) return;
      insertQuote(text);
    });
  });

  $effect(() => {
    if (!receivesFocusedInput) return;
    const p = session.pendingInput;
    if (!p) return;
    if (isReadOnly) {
      session.update({ pendingInput: null });
      return;
    }
    input.text = p;
    session.update({ pendingInput: null });
    requestInputFocus();
  });

  $effect(() => {
    const handleFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      const requestedTabId = detail?.tabId;
      if (
        requestedTabId === undefined
          ? !isFocusedPaneComposer
          : requestedTabId !== targetTabId
      )
        return;
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
      ownsVoice &&
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
    if (
      isActiveMode &&
      ownsVoice &&
      isReadOnly &&
      (voiceState === "recording" || voice.starting)
    )
      voice.cancel();
    if (isReadOnly) composerEl?.clearCompletions();
  });

  $effect(() => {
    if (!isPrimary) return;
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
      if (
        isActiveMode &&
        ownsVoice &&
        (voiceState === "recording" || voice.starting)
      )
        voice.cancel();
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
    if (!ownsVoice) return;
    const enabled = voiceModeEnabled;
    const visible = windowCtx.visible;
    const busy = isBusy;
    const vstate = voiceState;
    const dictationFocus = dictation.focusedTarget;
    const modelReady = voiceModel.ready;
    const retryReady =
      voice.errorKind === "transient" && voiceRetry.canRetry(retryClock);

    if (prevVoiceMode && !enabled && (vstate === "recording" || voice.starting))
      voice.cancel();
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
      enabled: () => isActiveMode && ownsVoice && !isReadOnly,
    },
  );
  useKeybinding("voice.toggle-recorder", toggleVoice, {
    enabled: () =>
      isActiveMode &&
      ownsVoice &&
      !isReadOnly &&
      !isDictationTarget(document.activeElement),
  });
  // ─── Reference composer wiring ───

  function previewFile(path: string) {
    requestFilePreview({ path, tabId: targetTabId });
  }

  /** Keep the target tab's plan/work refs in sync with the editor's tokens. */
  function handleRefsChange(
    nextPlanRefs: PlanReference[],
    nextWorkRefs: WorkReference[],
  ) {
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
      ipcContext: session.ctxFor(targetTabId),
      clearTab: () => session.clearTab(tabId),
      addSystemMessage: (message) => session.addSystemMessage(message, tabId),
      appendGlobalInstructions: (text) => {
        const existing = theme.extraInstructions.trim();
        theme.update({
          extraInstructions: existing ? `${existing}\n\n${text}` : text,
        });
      },
      requestInputFocus: refocusComposer,
    });
  }

  // A Solus built-in command was picked from the menu. The composer has already
  // cleared its completion state; here we either insert its template text or run
  // it outright.
  function handleSolusCommand(cmd: SlashCommand) {
    if (isReadOnly) return;
    if (cmd.insertTextOnSelect) {
      const text = cmd.insertTextOnSelect;
      input.text = text;
      composerEl?.setValueAndCursor(text);
      refocusComposer();
      return;
    }
    input.text = "";
    composerEl?.clearEditor();
    executeCommand(cmd);
  }

  // ─── Core input handlers ───

  function sendPrompt(prompt: string, options: { refocus?: boolean } = {}) {
    savePromptToHistory(prompt);
    input.text = "";
    resetHistoryNavigation();
    composerEl?.clearEditor();
    if (mode === "pill") {
      session.isExpanded = true;
    }
    session.sendMessage(prompt || "See attached files", undefined, tabId);

    if (options.refocus !== false) {
      refocusComposer();
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
      input.text = "";
      composerEl?.clearEditor();
      executeCommand(solusCommand.cmd, solusCommand.argument);
      refocusComposer();
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
    input.text = next;
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
    input.text = md;
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
          if (attachment) session.addAttachments([attachment], tabId);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }

  function handleInterrupt() {
    session.interruptTab(targetTabId);
    window.solus.stopTab(session.ctxFor(targetTabId));
    refocusComposer();
  }
</script>

<div
  class="flex flex-col w-full relative"
  style="contain:layout paint"
  onfocusin={() => claimVoice(true)}
>
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
        <span class="truncate"
          >{boundTask?.title ?? `#${sess.boundTaskId}`}</span
        >
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
        onRemove={(id) => session.removeAttachment(id, tabId)}
      />
    </div>
  {/if}

  {#if leadingActions}
    <div class="flex flex-col w-full">
      <div class="min-w-0">
        {@render editorOrWaveform()}
      </div>
      <!-- Keep the controls proportional to the composer text preference. -->
      <div
        class="flex items-center w-full"
        style="padding-top:0.125rem;zoom:var(--solus-font-scale,1)"
      >
        {@render leadingActions()}
        <div
          class="flex items-center gap-1 shrink-0 ml-auto"
          style="padding-bottom:0.125rem"
        >
          {@render actionButtons()}
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
        style="zoom:var(--solus-font-scale,1)"
      >
        {@render actionButtons()}
      </div>
    </div>
  {/if}

  {#if ownsVoice && voice.error}
    <div class="px-1 pb-2 text-[0.6875rem] text-(--solus-status-error)">
      {voice.error}
    </div>
  {/if}
</div>

{#snippet actionButtons()}
  {#if isBusy && (isMobile || !isPrimary)}
    {@render stopButton()}
  {/if}
  {#if !(isMobile && isBusy)}
    {@render voiceButtons()}
    {@render sendButton()}
  {/if}
{/snippet}

{#snippet editorOrWaveform()}
  {#if hasMountedWaveform}
    <div
      class="flex items-center gap-2"
      style="padding:0.75rem 0"
      style:display={showWaveform ? null : "none"}
    >
      <div class="min-w-0 flex-1">
        <WaveformVisualizer
          rmsRef={voice.rmsRef}
          color="var(--solus-accent)"
          active={showWaveform}
        />
      </div>
    </div>
  {/if}
  <div style:display={showWaveform ? "none" : null}>
    <PromptEditor
      bind:this={composerEl}
      value={editorValue}
      onValueChange={handleEditorChange}
      onEmptyChange={(empty) => (editorHasText = !empty)}
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
    state={voiceControlState}
    rmsRef={voice.rmsRef}
    waiting={isVoiceWaiting}
    disabled={isConnecting || isReadOnly || !voiceModel.ready}
    progressPct={!voiceModel.ready ? voiceModel.progressPct : null}
    idleTooltip={idleVoiceTooltip}
    onCancel={() => voice.cancel()}
    onConfirm={() => voice.stop()}
    onToggle={toggleVoice}
  />
{/snippet}
