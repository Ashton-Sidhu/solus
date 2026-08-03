<script lang="ts">
  import { untrack } from "svelte";
  import {
    ArrowBendDownRightIcon,
    ArrowUpIcon,
    SquareIcon,
    XIcon,
  } from "phosphor-svelte";
  import {
    getWorkspaceContext,
    getStatusBarContext,
    getSettingsContext,
    getVoiceModelStore,
    getWindowContext,
    runtime,
    savedPrompts,
    toasts,
  } from "../../contexts";
  import type {
    PlanReference,
    PromptDelivery,
    WorkReference,
    SessionReference,
  } from "../../../shared/types";
  import { isSteerableStatus, worktreeProjectRoot } from "../../../shared/types";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import AttachmentChips from "./AttachmentChips.svelte";
  import SavedPromptsControl from "./SavedPromptsControl.svelte";
  import { SLASH_COMMANDS, type SlashCommand } from "./slash-commands";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import WaveformVisualizer from "./WaveformVisualizer.svelte";
  import RecordingControls from "./RecordingControls.svelte";
  import { dictation, isDictationTarget } from "../../lib/dictation.svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { FOCUS_INPUT_EVENT, requestInputFocus } from "../../lib/inputFocus";
  import { requestFilePreview } from "../../lib/filePreview";
  import { VoiceRetryTracker } from "./lib/voice-retry.svelte";
  import { formatReleaseTime } from "../conversation/lib/queued-prompts";
  import { quotedReplyDraft } from "../../lib/quoted-reply";
  import { pendingPlanForPrompt } from "./lib/pending-plan";

  const HISTORY_KEY = "solus-prompt-history";
  const MAX_HISTORY = 100;

  import type { Snippet } from "svelte";

  interface Props {
    mode?: "pill" | "editor";
    tabId?: string;
    /** Receives the saved-prompts control, which the toolbar seats in the left
     *  cluster beside the pickers rather than out with the mic and send: saving
     *  a prompt is a composer decision, not a send action. It is handed over as
     *  a snippet because every prop it needs is private to this bar. */
    leadingActions?: Snippet<[Snippet]>;
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
  const pendingPlan = $derived(
    pendingPlanForPrompt(sess, session.planStore.plans),
  );
  const isActiveMode = $derived(mode === windowCtx.viewMode);
  const isMobile = $derived(runtime.isMobileViewport);
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isConnecting = $derived(sess?.status === "connecting");
  const activeProvider = $derived(sess?.provider ?? theme.activeAgent);
  // Every provider steers; the turn just has to have actually started.
  const canSteer = $derived(!!sess && isSteerableStatus(sess.status));
  const isReadOnly = $derived(!!sess?.readOnlyReason);
  const attachments = $derived(input.attachments);
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  const pluginCommands = $derived(
    sess?.pluginCommands ?? session.pluginCommands,
  );
  // Working directory driving @-file search and plan/work lookup in the composer.
  const composerCwd = $derived(
    sess?.gitContext?.worktreePath ??
      sess?.workingDirectory ??
      statusBar.ctxFor(targetTabId).workingDirectory,
  );
  // Saved prompts file under the project, not the worktree, so a prompt written
  // in one worktree is there in its siblings and in the main checkout.
  const composerProjectRoot = $derived(
    sess?.gitContext?.repoRoot ??
      (composerCwd && composerCwd !== "~"
        ? worktreeProjectRoot(composerCwd)
        : null),
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
  // The editor's reactive `value` sync.
  const inputText = $derived(input.text);

  // When this bar is inactive (hidden with display:none) its CodeMirror
  // instance is still alive. Freeze the draft at the moment this bar goes inactive;
  // switch back to the live reactive value the instant it becomes active again.
  let frozenText = $state(untrack(() => input.text));
  $effect(() => {
    if (!isActiveMode) frozenText = untrack(() => input.text);
  });
  const editorValue = $derived(isActiveMode ? input.text : frozenText);
  let composerEl: ReturnType<typeof PromptEditor> | null = $state(null);
  /** The composer card — the saved-prompts sheet matches its width. */
  let composerRootEl = $state<HTMLElement | null>(null);

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

  // Editor emptiness, updated synchronously by the editor on every
  // keystroke — unlike `inputText`, which only reflects the 200ms-debounced
  // markdown emit. Seeding from `inputText` at mount/tab-switch is safe
  // because PromptEditor immediately reports the true state once its `value`
  // prop lands.
  let editorHasText = $state(untrack(() => inputText.trim().length > 0));
  const hasContent = $derived(
    editorHasText ||
      attachments.length > 0 ||
      planRefs.length > 0 ||
      workRefs.length > 0 ||
      sessionRefs.length > 0,
  );
  const canSend = $derived(!isConnecting && !isReadOnly && hasContent);
  const planRefs = $derived(input.planRefs);
  const workRefs = $derived(input.workRefs);
  const sessionRefs = $derived(input.sessionRefs);
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
          (isVoiceWaiting
            ? "Voice mode waiting..."
            : `Voice input (${comboHint("voice.toggle-recorder")})`)),
  );
  // §1a — the composer stays an ordinary composer while a limit holds the queue.
  // Its placeholder is the only thing that changes, so the limit is never stated
  // twice: the bubbles and their caption own the rest.
  const isRateLimited = $derived(sess?.status === "rate_limited");
  const resetsAt = $derived(sess?.rateLimitInfo?.resetsAt);
  const hasQueuedPrompts = $derived((sess?.outboundPrompts.length ?? 0) > 0);

  const placeholder = $derived(
    isReadOnly
      ? (sess?.readOnlyReason ?? "This session is read-only.")
      : isConnecting
        ? "Initializing..."
        : voiceState === "transcribing"
          ? "Transcribing..."
          : pendingPlan
            ? "Send feedback to revise the pending plan..."
          : isRateLimited
            ? resetsAt
              ? `Add to the queue — rate limited until ${formatReleaseTime(resetsAt)}`
              : "Add to the queue — rate limited"
            : hasQueuedPrompts
              ? "Add to the queue..."
              : isBusy
                ? voiceModeEnabled && ownsVoice
                  ? "Waiting for Claude..."
                  : canSteer
                    ? isMobile
                      ? "Send to steer this response..."
                      : "Enter to steer now · ⌥Enter to queue next"
                    : "Type to queue a message..."
                : "Plan, Build, Automate · @ for context",
  );

  // ─── Focus management ───

  function refocusComposer() {
    if (isPrimary) requestInputFocus();
    else composerEl?.focus();
  }

  // Recording replaces the editor with the waveform. Once the recorder settles
  // and the editor is visible again, return keyboard input to the composer.
  let previousVoiceStateForFocus = untrack(() => voiceState);
  $effect(() => {
    const previousState = previousVoiceStateForFocus;
    const currentState = voiceState;
    previousVoiceStateForFocus = currentState;

    if (
      !isActiveMode ||
      !ownsVoice ||
      previousState === "idle" ||
      currentState !== "idle" ||
      showWaveform
    )
      return;

    requestAnimationFrame(() => {
      if (isActiveMode && ownsVoice && voiceState === "idle" && !showWaveform) {
        refocusComposer();
      }
    });
  });

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
    const quoted = quotedReplyDraft(text);
    if (!quoted) return;
    const existing = input.text;
    const next = existing.trim()
      ? `${existing}\n\n${quoted}`
      : quoted;
    input.text = next;
    composerEl?.setValueAndCursor(next, true, true);
    requestInputFocus();
  }

  $effect(() => {
    if (!isActiveMode) return;
    return window.solus.onQuoteSelection((text, sourceTabId) => {
      if (sourceTabId !== targetTabId || isReadOnly) return;
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

  let prevVoiceError = untrack(() => voice.error);
  $effect(() => {
    const error = voice.error;
    if (error === prevVoiceError) return;
    prevVoiceError = error;
    if (error && isActiveMode && ownsVoice) toasts.error(error);
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
    const unsub = window.solusNative?.onWindowShown(() => {
      if (!isActiveMode) return;
      if (!session.sessionPickerOpen && !isReadOnly) {
        requestInputFocus();
      }
    });
    return unsub ?? (() => {});
  });

  $effect(() => {
    const unsub = window.solusNative?.onWindowHidden(() => {
      if (
        isActiveMode &&
        ownsVoice &&
        (voiceState === "recording" || voice.starting)
      )
        voice.cancel();
    });
    return unsub ?? (() => {});
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

  /** Keep the target tab's plan/work/session refs in sync with the editor's tokens. */
  function handleRefsChange(
    nextPlanRefs: PlanReference[],
    nextWorkRefs: WorkReference[],
    nextSessionRefs: SessionReference[],
  ) {
    // Avoid needless reassignment (and the derived churn it triggers) when both
    // the editor and the stored refs are empty — the common typing case.
    if (nextPlanRefs.length || input.planRefs.length)
      input.planRefs = nextPlanRefs;
    if (nextWorkRefs.length || input.workRefs.length)
      input.workRefs = nextWorkRefs;
    if (nextSessionRefs.length || input.sessionRefs.length)
      input.sessionRefs = nextSessionRefs;
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

  function clearComposer() {
    input.text = "";
    composerEl?.clearEditor();
  }

  async function handleGoalCommand(argument: string) {
    if (isReadOnly) return;
    const goalSession = session.sessionFor(targetTabId);
    const normalized = argument.trim();
    const isCodexGoal = goalSession?.provider === "codex";

    if (!normalized) {
      clearComposer();
      await session.refreshThreadGoal(targetTabId);
      if (session.sessionFor(targetTabId)?.goal) {
        session.revealGoal(targetTabId);
      } else {
        session.addSystemMessage("No goal is defined for this session yet.", targetTabId);
      }
      refocusComposer();
      return;
    }

    if (!goalSession?.agentSessionId) {
      if (
        normalized === "clear" ||
        normalized === "pause" ||
        normalized === "resume" ||
        normalized === "edit" ||
        normalized.startsWith("edit ")
      ) {
        clearComposer();
        session.addSystemMessage(
          isCodexGoal ? "Define a goal before changing it." : "Goal changes are only supported for Codex sessions.",
          targetTabId,
        );
        refocusComposer();
        return;
      }
      if (normalized.length > 4000) {
        session.addSystemMessage("Goal objectives must be 4,000 characters or fewer.", targetTabId);
        refocusComposer();
        return;
      }
      if (goalSession) {
        goalSession.pendingGoalObjective = normalized;
        sendPrompt(normalized);
      } else {
        sendPrompt(normalized);
        const createdSession = session.sessionFor(session.activeTabId);
        if (createdSession) createdSession.pendingGoalObjective = normalized;
      }
      return;
    }

    try {
      if (!isCodexGoal) await session.refreshThreadGoal(targetTabId);
      if (normalized === "clear") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage("Clearing goals is only supported for Codex sessions.", targetTabId);
          refocusComposer();
          return;
        }
        clearComposer();
        await session.clearThreadGoal(targetTabId);
        if (panes.secondaryContent.kind === "goal" && panes.secondaryContent.tabId === targetTabId) {
          panes.closeSecondary();
        }
      } else if (normalized === "pause" || normalized === "resume") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage("Pausing goals is only supported for Codex sessions.", targetTabId);
          refocusComposer();
          return;
        }
        clearComposer();
        await session.setThreadGoal(targetTabId, {
          status: normalized === "pause" ? "paused" : "active",
        });
        session.revealGoal(targetTabId);
      } else if (normalized === "edit") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage("Editing goals is only supported for Codex sessions.", targetTabId);
          refocusComposer();
          return;
        }
        clearComposer();
        await session.refreshThreadGoal(targetTabId);
        if (goalSession.goal) session.revealGoal(targetTabId);
      } else {
        if (!isCodexGoal && normalized.startsWith("edit ")) {
          clearComposer();
          session.addSystemMessage("Editing goals is only supported for Codex sessions.", targetTabId);
          refocusComposer();
          return;
        }
        const objective = normalized.startsWith("edit ") ? normalized.slice(5).trim() : normalized;
        if (!objective || objective.length > 4000) {
          session.addSystemMessage("Goal objectives must be between 1 and 4,000 characters.", targetTabId);
          refocusComposer();
          return;
        }
        const currentGoal = session.sessionFor(targetTabId)?.goal;
        if (!isCodexGoal && currentGoal) {
          clearComposer();
          session.addSystemMessage("Editing goals is only supported for Codex sessions.", targetTabId);
          refocusComposer();
          return;
        }
        if (currentGoal) await session.setThreadGoal(targetTabId, { objective, status: "active" });
        else await session.createThreadGoal(targetTabId, objective);
        session.revealGoal(targetTabId);
        if (!normalized.startsWith("edit ")) sendPrompt(objective);
        else clearComposer();
      }
    } catch (error) {
      session.addSystemMessage(
        `Couldn't update goal: ${error instanceof Error ? error.message : String(error)}`,
        targetTabId,
      );
    }
    refocusComposer();
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

  function sendPrompt(
    prompt: string,
    options: { refocus?: boolean; delivery?: PromptDelivery } = {},
  ) {
    savePromptToHistory(prompt);
    input.text = "";
    resetHistoryNavigation();
    composerEl?.clearEditor();
    if (mode === "pill") {
      session.isExpanded = true;
    }
    // A saved prompt that has now been sent has served its purpose. This is the
    // one composer send funnel, and the draft is already gone by here, so the
    // paths where sendMessage bails have lost the draft either way.
    const sentSavedPromptId = input.savedPromptId;
    input.savedPromptId = null;
    if (sentSavedPromptId && composerProjectRoot) {
      void savedPrompts.remove(composerProjectRoot, sentSavedPromptId);
    }
    if (pendingPlan) {
      // Match the plan surface's Revise action: answer the held ExitPlanMode
      // request, keep the provider in plan mode, and send this text as feedback
      // instead of letting it become an ordinary queued prompt.
      void session.rejectPlan(pendingPlan.id, prompt || "See attached files");
    } else {
      session.sendMessage(
        prompt || "See attached files",
        undefined,
        tabId,
        options.delivery,
      );
    }

    if (options.refocus !== false) {
      refocusComposer();
    }
  }

  function handleSend(delivery: PromptDelivery = "steer") {
    if (isReadOnly) return;
    let prompt = inputText.trim();
    if (
      !prompt &&
      attachments.length === 0 &&
      planRefs.length === 0 &&
      workRefs.length === 0 &&
      sessionRefs.length === 0
    )
      return;
    if (isConnecting) return;

    if (/^\/goal(?:\s|$)/.test(prompt)) {
      void handleGoalCommand(prompt.slice("/goal".length));
      return;
    }

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

    sendPrompt(prompt, { delivery });
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
      handleSend(e.altKey ? "queue" : "steer");
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
    session.apiFor(targetTabId).stopTab(session.ctxFor(targetTabId));
    refocusComposer();
  }
</script>

<div
  bind:this={composerRootEl}
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
    <div class="-ml-1 pt-1.5">
      <AttachmentChips
        {attachments}
        onRemove={(id) => session.removeAttachment(id, tabId)}
      />
    </div>
  {/if}

  {#if leadingActions}
    <!-- Two stacked zones in one card: a text well (its own vertical padding
         comes from the editor, symmetric so the first line sits centred in the
         well) and a toolbar row that never moves relative to the card's bottom
         edge. The well is inset a further 6px so prose clears the controls'
         optical left edge. -->
    <div class="flex flex-col w-full">
      <div class="min-w-0 px-1.5">
        {@render editorOrWaveform()}
      </div>
      <!-- Keep the controls proportional to the composer text preference. -->
      <div
        class="flex w-full items-center gap-2"
        style="zoom:var(--solus-font-scale,1)"
      >
        {@render leadingActions(savedPromptsControl)}
        <div class="ml-auto flex shrink-0 items-center gap-2">
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
        class="flex shrink-0 items-center gap-1 {isMobile ? 'pb-0.5' : 'pb-1.5'}"
        style="zoom:var(--solus-font-scale,1)"
      >
        {@render actionButtons()}
      </div>
    </div>
  {/if}

</div>

{#snippet savedPromptsControl()}
  {#if !isMobile}
    <SavedPromptsControl
      tabId={targetTabId}
      projectRoot={composerProjectRoot}
      active={isActiveMode && receivesFocusedInput}
      {isReadOnly}
      anchorEl={composerRootEl}
      onClearEditor={() => composerEl?.clearEditor()}
      onRefocus={refocusComposer}
    />
  {/if}
{/snippet}

{#snippet actionButtons()}
  <!-- The pill-mode bar has no toolbar row to seat it in, so it keeps the saved
       control out here with the mic and send. -->
  {#if !leadingActions}
    {@render savedPromptsControl()}
  {/if}
  {#if isBusy && (isMobile || !isPrimary)}
    {@render stopButton()}
  {/if}
  {#if !(isMobile && isBusy)}
    {@render voiceButtons()}
    {@render sendButton()}
  {/if}
{/snippet}

{#snippet editorOrWaveform()}
  <!-- The editor's type vars live on this wrapper, not on the editor itself, so
       the waveform inherits the same padding and stands exactly as tall as the
       text well it replaces — entering voice mode must not resize the card. -->
  <div
    class="[--solus-font-weight-body:var(--solus-font-weight-user-content)] {mode ===
    'editor'
      ? '[--plain-editor-font-size:0.84375rem] [--plain-editor-padding:1.25rem_0_1.25rem_0]'
      : ''}"
  >
    {#if hasMountedWaveform}
      <div
        class="flex items-center gap-2 [padding:var(--plain-editor-padding,0.9375rem_0_0.9375rem_0.25rem)]"
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
        tabId={targetTabId}
        workingDirectory={composerCwd}
        onRefsChange={handleRefsChange}
        includeSolusCommands
        onSolusCommand={handleSolusCommand}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onPlanRefClick={(planId) => session.openPlanModal(planId)}
        onWorkRefClick={(workId, title) => session.openWorkModal(workId, title)}
        onPrRefClick={(number, title) =>
          void session.enterPrReview(number, title, {
            ctx: session.ctxForDirectory(composerCwd),
          })}
        onFileRefClick={previewFile}
        {placeholder}
        readOnly={isReadOnly}
        disabled={isReadOnly || isConnecting || voiceState === "transcribing"}
        maxHeight={INPUT_MAX_HEIGHT}
      />
    </div>
  </div>
{/snippet}

{#snippet sendButton()}
  <!-- The bottom-right corner is always the next thing you can do, so the
       button stays put and goes neutral rather than disappearing: fill is spent
       on send, and only once there is something to send. -->
  {#if !showWaveform}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps}
      onclick={() => handleSend()}
      disabled={!canSend}
      data-testid="send-button"
      aria-label={canSteer ? "Steer the live turn" : "Send message"}
      class="flex shrink-0 items-center justify-center rounded-lg transition-[background-color,box-shadow,transform] duration-150 enabled:active:scale-[0.96] {isMobile
        ? 'size-8'
        : 'size-[1.875rem]'} {canSend
        ? 'bg-(--solus-accent) text-(--solus-text-on-accent) shadow-[0_0.25rem_0.75rem_-0.375rem_var(--solus-send-glow)] hover:shadow-[0_0.3125rem_0.875rem_-0.375rem_var(--solus-send-glow)]'
        : 'cursor-default bg-(--solus-surface-active) text-(--solus-text-tertiary)'}"
    >
      {#if canSteer && canSend}
        <ArrowBendDownRightIcon size={14} weight="bold" />
      {:else}
        <ArrowUpIcon size={14} weight="bold" />
      {/if}
    </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={!canSend
          ? null
          : canSteer
            ? { label: "Steer this response · Queue next with ⌥Enter", shortcut: "Enter" }
            : isBusy
              ? "Queue message (Enter)"
              : "Send (Enter)"}
      />
    </TooltipUI.Root>
  {/if}
{/snippet}

{#snippet stopButton()}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    onmousedown={(e) => e.preventDefault()}
    onclick={handleInterrupt}
    data-testid="mobile-stop-button"
    class="w-9 h-9 rounded-full flex items-center justify-center text-(--solus-text-on-accent) bg-(--solus-stop-bg) shadow-[0_0.125rem_0.5rem_rgba(239,68,68,0.24),0_0.0625rem_0.125rem_rgba(0,0,0,0.2)] transition-[box-shadow,transform,background] duration-150 active:scale-[0.94] hover:bg-(--solus-stop-hover)"
    aria-label="Stop current task"
  >
    <SquareIcon size={11} weight="fill" />
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={"Stop current task"} />
  </TooltipUI.Root>
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
