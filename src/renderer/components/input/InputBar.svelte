<script lang="ts">
  import { untrack } from "svelte";
  import { ArrowBendDownRightIcon, ArrowUpIcon, XIcon } from "phosphor-svelte";
  import {
    getWorkspaceContext,
    getStatusBarContext,
    getSettingsContext,
    getAgentContext,
    getVoiceModelStore,
    getWindowContext,
    runtime,
    savedPrompts,
  } from "../../contexts";
  import {
    cycledModelId,
    modelConfigForModel,
    nextPermissionMode,
  } from "../../contexts/workspace/run-config";
  import {
    defaultModelIdFor,
    clampReasoningEffort,
  } from "../pickers/lib/picker-selection";
  import { track } from "../../lib/analytics";
  import { toasts } from "../../lib/toasts";
  import type {
    PlanReference,
    Prompt,
    PromptDelivery,
    RunConfig,
    WorkReference,
    SessionReference,
  } from "../../../shared/types";
  import {
    isSteerableStatus,
    worktreeProjectRoot,
  } from "../../../shared/types";
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
  import {
    answersForQuestionNote,
    pendingQuestionForPrompt,
  } from "./lib/pending-question";
  import { localApi } from "@client-core/local-api";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { hostPolicy } from "@client-core/host-policy";
  import { serverConnections } from "@client-core/server-connections";
  import {
    pastedImageAttachment,
    uploadPastedImage,
  } from "./lib/attachment-upload";

  const HISTORY_KEY = "solus-prompt-history";
  const MAX_HISTORY = 100;

  import type { Snippet } from "svelte";

  interface Props {
    mode?: "pill" | "editor";
    /** The conversation this bar composes for, or `null` when nothing has
     *  started behind it — a session draft. The bar is addressed by session and
     *  looks its tab up from that; it never resolves a session from whichever
     *  tab happens to be active, which a draft would answer wrongly. */
    sessionId: string | null;
    /** The tab this bar is docked beside, when it is docked beside one. Only
     *  view routing uses it — two tabs can watch one session, and quotes and
     *  file previews belong to the pane the user is looking at. */
    tabId?: string;
    /** This is the workspace's own composer: it follows the leading pane, takes
     *  app-level focus requests and owns the mic by default. Separate from
     *  `tabId`, which says where the bar sits, not what it speaks for. */
    isPrimary?: boolean;
    /** The pane this bar fills, when it fills one of its own. There is exactly
     *  one composer per pane, so this — not the tab, which a draft lacks — is
     *  what decides which bar the focused pane's keystrokes and the shared mic
     *  belong to. */
    paneId?: string;
    /** How the target will run. A draft's run and a started session's are the
     *  same shape in the same position, so @-file search and saved prompts find
     *  their project without asking which of the two they were handed. */
    run?: RunConfig;
    /** The unsent message this bar edits. Passed in rather than resolved here,
     *  so the bar never needs to know whether it belongs to a conversation or to
     *  a composer that has no session yet. Mutated in place. */
    prompt: Prompt;
    /** Where Send goes when there is no conversation behind this bar. A session
     *  draft supplies it; a chat leaves it unset and the message goes to the
     *  session as usual. Returns false to keep the prompt for another try. */
    onDispatch?: (text: string, delivery: PromptDelivery) => boolean;
    /** Receives the saved-prompts control, which the toolbar seats in the left
     *  cluster beside the pickers rather than out with the mic and send: saving
     *  a prompt is a composer decision, not a send action. It is handed over as
     *  a snippet because every prop it needs is private to this bar. */
    leadingActions?: Snippet<[Snippet]>;
  }
  let {
    mode = "pill",
    sessionId,
    tabId,
    isPrimary = false,
    paneId,
    run,
    prompt = $bindable(),
    onDispatch,
    leadingActions,
  }: Props = $props();

  const INPUT_MAX_HEIGHT = $derived(mode === "editor" ? 260 : 140);

  const theme = getSettingsContext();
  const agent = getAgentContext();
  const voiceModel = getVoiceModelStore();
  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const windowCtx = getWindowContext();
  const router = session.router;

  const sess = $derived(sessionId ? session.sessions[sessionId] : undefined);
  // Where the target session is showing, if it is showing anywhere: a draft has
  // no tab at all, so this is `undefined` and every tab-addressed action below
  // stays put rather than firing at the tab that happens to be active.
  const targetTabId = $derived(
    sessionId ? session.tabIdForSession(sessionId, tabId) : undefined,
  );
  // One composer per pane, so the focused pane names the bar that has the
  // keyboard. The workspace's own dock belongs to the leading pane.
  const isFocusedPaneComposer = $derived(
    router.focusedPaneId === (paneId ?? router.leadingPane.id),
  );
  const receivesFocusedInput = $derived(
    isFocusedPaneComposer || (isPrimary && session.focusedChatTabId === null),
  );
  const willStartNewTask = $derived(
    !!targetTabId && session.willStartNewTask(targetTabId),
  );
  const pendingPlan = $derived(
    pendingPlanForPrompt(sess, session.planStore.plans),
  );
  const pendingQuestion = $derived(pendingQuestionForPrompt(sess));
  const isActiveMode = $derived(mode === windowCtx.viewMode);
  const isMobile = $derived(runtime.isMobileViewport);
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isConnecting = $derived(sess?.status === "connecting");
  const activeProvider = $derived(run?.provider ?? theme.activeAgent);
  // Every provider steers; the turn just has to have actually started.
  const canSteer = $derived(!!sess && isSteerableStatus(sess.status));
  const isReadOnly = $derived(!!sess?.readOnlyReason);
  // Model and permission-mode shortcuts belong to the composer, not to a tab
  // resolved from global focus: the focused pane's bar edits the run it is
  // composing for, in place, so a draft and a started session are one case. The
  // dock has no pane of its own, so it answers only while it is the leading
  // composer — `isPrimary` drops when a draft covers it — keeping exactly one
  // bar eligible at a time.
  const ownsComposerShortcuts = $derived(
    isActiveMode &&
      isFocusedPaneComposer &&
      (paneId !== undefined || isPrimary) &&
      !!run &&
      !isReadOnly,
  );
  const attachments = $derived(prompt.attachments);
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  const pluginCommands = $derived(
    sess?.pluginCommands ?? session.pluginCommands,
  );
  // Working directory driving @-file search and plan/work lookup in the composer.
  const composerCwd = $derived(
    run?.gitContext?.worktreePath ??
      run?.workingDirectory ??
      statusBar.ctxForRun(run).workingDirectory,
  );
  // Saved prompts file under the project, not the worktree, so a prompt written
  // in one worktree is there in its siblings and in the main checkout.
  const composerProjectRoot = $derived(
    run?.gitContext?.repoRoot ??
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

  function savePromptToHistory(text: string) {
    if (!text || promptHistory[promptHistory.length - 1] === text) return;

    promptHistory.push(text);
    if (promptHistory.length > MAX_HISTORY) promptHistory.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(promptHistory));
  }

  function resetHistoryNavigation() {
    historyIndex = -1;
    savedInput = "";
  }

  // ─── Editor state ───

  // The prompt is handed in, so switching tabs swaps the whole object and the
  // editor follows along with no manual save/restore — see the editor's
  // reactive `value` sync.
  const inputText = $derived(prompt.text);

  // When this bar is inactive (hidden with display:none) its CodeMirror
  // instance is still alive. Freeze the draft at the moment this bar goes inactive;
  // switch back to the live reactive value the instant it becomes active again.
  let frozenText = $state(untrack(() => prompt.text));
  $effect(() => {
    if (!isActiveMode) frozenText = untrack(() => prompt.text);
  });
  const editorValue = $derived(isActiveMode ? prompt.text : frozenText);
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
  const voiceOwnerId = $derived(
    `input-bar:${mode}:${paneId ?? (isPrimary ? "primary" : (tabId ?? "composer"))}`,
  );
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
    const text = transcript.trim();
    if (!text || isConnecting || isReadOnly) return;
    if (theme.autoSendVoiceTranscripts) {
      sendPrompt(text, { refocus: false });
    } else {
      const existing = prompt.text;
      const next = existing.trim() ? `${existing} ${text}` : text;
      prompt.text = next;
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
    if (claimed && startIfEnabled && canAutoStart())
      voice.startConversational();
  }

  function toggleVoice() {
    voice.toggleConversationalFor(voiceOwnerId, handleVoiceTranscript, () =>
      canAutoStart(),
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
  const planRefs = $derived(prompt.planRefs);
  const workRefs = $derived(prompt.workRefs);
  const sessionRefs = $derived(prompt.sessionRefs);
  // Work this session is actively collaborating on — its content is injected
  // into each prompt so the agent revises the live version.
  const boundWork = $derived(
    sess?.boundWorkId ? session.worksStore.get(sess.boundWorkId) : null,
  );
  function unbindWork() {
    if (sess) sess.boundWorkId = null;
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
            : pendingQuestion
              ? "Send a note to answer the pending question..."
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
    void sess?.run.workingDirectory;
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
    const existing = prompt.text;
    const next = existing.trim() ? `${existing}\n\n${quoted}` : quoted;
    prompt.text = next;
    composerEl?.setValueAndCursor(next, true, true);
    requestInputFocus();
  }

  $effect(() => {
    if (!isActiveMode) return;
    return localApi.onQuoteSelection((text, sourceTabId) => {
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
    prompt.text = p;
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

  // ─── Model / mode shortcuts ───

  // Both edit `run` in place — the very object the model and mode chips below
  // read — so the change lands on whatever this bar composes for without a
  // session-versus-draft branch or a tab lookup.
  function cycleModel() {
    if (!run || isBusy) return;
    const metadata = agent.metadata[activeProvider] ?? agent.activeMetadata;
    const models = metadata?.models;
    if (!models || models.length === 0) return;
    const nextModelId = cycledModelId(run, models, metadata?.defaultModel ?? null);
    if (!nextModelId) return;
    Object.assign(run.modelConfig, modelConfigForModel(run, nextModelId));
    track("model_changed", { via: "keybinding" });
    refocusComposer();
  }
  function cyclePermissionMode() {
    if (!run) return;
    run.permissionMode = nextPermissionMode(run.permissionMode);
    track("permission_mode_set", { mode: run.permissionMode, via: "keybinding" });
    refocusComposer();
  }
  // A started session hands off to the new agent (a real provider switch); a
  // draft has none, so it rewrites its run and takes the new agent's default
  // model — the same two branches the chip's agent row runs.
  function cycleAgent() {
    if (!run || isBusy) return;
    const enabledAgents = agent.agents.filter(
      (candidate) => agent.metadata[candidate.id]?.available === true,
    );
    if (enabledAgents.length <= 1) return;
    const current = run.provider ?? theme.activeAgent;
    const idx = enabledAgents.findIndex((candidate) => candidate.id === current);
    const next = enabledAgents[(idx + 1) % enabledAgents.length];
    if (sessionId) {
      void session.switchActiveAgent(next.id, targetTabId, "keybinding");
    } else {
      const modelId = defaultModelIdFor(next.id, agent.metadata);
      run.provider = next.id;
      run.modelConfig.modelId = modelId;
      run.modelConfig.reasoningEffort = clampReasoningEffort(
        next.id,
        modelId,
        run.modelConfig.reasoningEffort,
      );
    }
    refocusComposer();
  }
  useKeybinding("global.cycle-model", cycleModel, {
    enabled: () => ownsComposerShortcuts,
  });
  useKeybinding("global.cycle-perm-mode", cyclePermissionMode, {
    enabled: () => ownsComposerShortcuts,
  });
  useKeybinding("global.cycle-agent", cycleAgent, {
    enabled: () => ownsComposerShortcuts,
  });
  // The run picker lives beside this bar but owns its own open state, so the
  // shortcut names the composer that fired it and lets that pane's picker
  // answer. `null` is the workspace dock, which has no pane of its own.
  useKeybinding(
    "global.run-picker",
    () =>
      window.dispatchEvent(
        new CustomEvent("solus:toggle-run-picker", {
          detail: { paneId: paneId ?? null },
        }),
      ),
    { enabled: () => ownsComposerShortcuts },
  );
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
    if (nextPlanRefs.length || prompt.planRefs.length)
      prompt.planRefs = nextPlanRefs;
    if (nextWorkRefs.length || prompt.workRefs.length)
      prompt.workRefs = nextWorkRefs;
    if (nextSessionRefs.length || prompt.sessionRefs.length)
      prompt.sessionRefs = nextSessionRefs;
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
      api: session.apiForRun(run),
      argument,
      // A command run from a draft's composer has no conversation to clear or
      // to speak into; it still runs, against the project the draft points at.
      ipcContext: targetTabId
        ? session.ctxFor(targetTabId)
        : session.ctxForDirectory(composerCwd),
      clearTab: () => {
        if (targetTabId) session.clearTab(targetTabId);
      },
      addSystemMessage: (message) => {
        if (targetTabId) session.addSystemMessage(message, targetTabId);
      },
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
    prompt.text = "";
    composerEl?.clearEditor();
  }

  async function handleGoalCommand(argument: string) {
    if (isReadOnly) return;
    const goalTabId = targetTabId;
    const normalized = argument.trim();
    // A goal belongs to a thread, and a draft has none yet. Its objective goes
    // out as the first prompt instead; the session that starts inherits it the
    // same way a started-but-idle tab's does.
    if (!goalTabId) {
      if (normalized) sendPrompt(normalized);
      return;
    }
    const goalSession = session.sessionFor(goalTabId);
    // A goal belongs to the thread, not to the tab showing it.
    const goalSessionId = goalSession?.id ?? "";
    const isCodexGoal = goalSession?.run.provider === "codex";

    if (!normalized) {
      clearComposer();
      await session.refreshThreadGoal(goalSessionId);
      if (session.sessionFor(goalTabId)?.goal) {
        session.revealGoal(goalTabId);
      } else {
        session.addSystemMessage(
          "No goal is defined for this session yet.",
          goalTabId,
        );
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
          isCodexGoal
            ? "Define a goal before changing it."
            : "Goal changes are only supported for Codex sessions.",
          goalTabId,
        );
        refocusComposer();
        return;
      }
      if (normalized.length > 4000) {
        session.addSystemMessage(
          "Goal objectives must be 4,000 characters or fewer.",
          goalTabId,
        );
        refocusComposer();
        return;
      }
      if (goalSession) goalSession.pendingGoalObjective = normalized;
      sendPrompt(normalized);
      return;
    }

    try {
      if (!isCodexGoal) await session.refreshThreadGoal(goalSessionId);
      if (normalized === "clear") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage(
            "Clearing goals is only supported for Codex sessions.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        clearComposer();
        await session.clearThreadGoal(goalSessionId);
        if (router.params("goal")?.sessionId === goalSessionId) {
          router.close("goal");
        }
      } else if (normalized === "pause" || normalized === "resume") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage(
            "Pausing goals is only supported for Codex sessions.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        clearComposer();
        await session.setThreadGoal(goalSessionId, {
          status: normalized === "pause" ? "paused" : "active",
        });
        session.revealGoal(goalTabId);
      } else if (normalized === "edit") {
        if (!isCodexGoal) {
          clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        clearComposer();
        await session.refreshThreadGoal(goalSessionId);
        if (goalSession.goal) session.revealGoal(goalTabId);
      } else {
        if (!isCodexGoal && normalized.startsWith("edit ")) {
          clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        const objective = normalized.startsWith("edit ")
          ? normalized.slice(5).trim()
          : normalized;
        if (!objective || objective.length > 4000) {
          session.addSystemMessage(
            "Goal objectives must be between 1 and 4,000 characters.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        const currentGoal = session.sessionFor(goalTabId)?.goal;
        if (!isCodexGoal && currentGoal) {
          clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          refocusComposer();
          return;
        }
        if (currentGoal)
          await session.setThreadGoal(goalSessionId, {
            objective,
            status: "active",
          });
        else await session.createThreadGoal(goalSessionId, objective);
        session.revealGoal(goalTabId);
        if (!normalized.startsWith("edit ")) sendPrompt(objective);
        else clearComposer();
      }
    } catch (error) {
      session.addSystemMessage(
        `Couldn't update goal: ${error instanceof Error ? error.message : String(error)}`,
        goalTabId,
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
      prompt.text = text;
      composerEl?.setValueAndCursor(text);
      refocusComposer();
      return;
    }
    prompt.text = "";
    composerEl?.clearEditor();
    executeCommand(cmd);
  }

  // ─── Core input handlers ───

  function sendPrompt(
    text: string,
    options: { refocus?: boolean; delivery?: PromptDelivery } = {},
  ): boolean {
    let accepted = true;
    if (pendingPlan) {
      // Match the plan surface's Revise action: answer the held ExitPlanMode
      // request, keep the provider in plan mode, and send this text as feedback
      // instead of letting it become an ordinary queued prompt.
      void session.rejectPlan(pendingPlan.id, text || "See attached files");
    } else if (pendingQuestion && text && targetTabId) {
      // Match the question card's free-text answer. Responding releases the held
      // provider turn; queuing this as a normal prompt would leave it blocked.
      session.respondQuestion(
        targetTabId,
        pendingQuestion.questionId,
        answersForQuestionNote(pendingQuestion, text),
      );
    } else if (onDispatch) {
      accepted = onDispatch(
        text || "See attached files",
        options.delivery ?? "steer",
      );
    } else {
      accepted = session.sendMessage(
        text || "See attached files",
        undefined,
        targetTabId,
        options.delivery,
      );
    }

    if (!accepted) {
      if (options.refocus !== false) refocusComposer();
      return false;
    }

    savePromptToHistory(text);
    prompt.text = "";
    resetHistoryNavigation();
    composerEl?.clearEditor();
    if (mode === "pill") {
      session.isExpanded = true;
    }
    const sentSavedPromptId = prompt.savedPromptId;
    prompt.savedPromptId = null;
    if (sentSavedPromptId && composerProjectRoot) {
      void savedPrompts.remove(composerProjectRoot, sentSavedPromptId);
    }

    if (options.refocus !== false) {
      refocusComposer();
    }
    return true;
  }

  function handleSend(
    delivery: PromptDelivery = "steer",
    options: { refocus?: boolean } = {},
  ): boolean {
    if (isReadOnly) return false;
    let text = inputText.trim();
    if (
      !text &&
      attachments.length === 0 &&
      planRefs.length === 0 &&
      workRefs.length === 0 &&
      sessionRefs.length === 0
    )
      return false;
    if (isConnecting) return false;

    if (/^\/goal(?:\s|$)/.test(text)) {
      void handleGoalCommand(text.slice("/goal".length));
      return false;
    }

    // Mobile keyboards sometimes autocorrect the skill name and insert it as
    // plain text before the slash command (e.g. "ui /ui rest"). Strip it.
    for (const skill of providerSkills) {
      const prefix = skill.name + " /" + skill.name;
      if (text.startsWith(prefix)) {
        text = text.slice(skill.name.length + 1);
        break;
      }
    }

    const solusCommand = solusCommandFromInput(inputText);
    if (solusCommand) {
      prompt.text = "";
      composerEl?.clearEditor();
      executeCommand(solusCommand.cmd, solusCommand.argument);
      refocusComposer();
      return false;
    }

    return sendPrompt(text, { delivery, refocus: options.refocus });
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
    prompt.text = next;
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
      const shouldStartAnotherTask =
        e.ctrlKey && !e.altKey && !e.metaKey && willStartNewTask;
      const accepted = handleSend(e.altKey ? "queue" : "steer", {
        refocus: !shouldStartAnotherTask,
      });
      if (shouldStartAnotherTask && accepted) {
        session.openSessionDraft({
          freshTask: true,
          via: "keybinding",
          sourceTabId: targetTabId,
        });
      }
    }
  }

  function handleEditorChange(md: string) {
    if (isReadOnly) return;
    prompt.text = md;
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
          const api = session.apiForRun(run);
          const ctx = targetTabId
            ? session.ctxFor(targetTabId)
            : session.ctxForDirectory(run?.workingDirectory ?? session.ctx.session.workingDirectory);
          try {
            const serverId = run?.serverId ?? LOCAL_SERVER_ID;
            const capabilities = await serverConnections.capabilitiesFor(serverId);
            const attachment = !windowCtx.isWeb && hostPolicy.isClientMachine(serverId)
              ? await api.pasteImage(dataUrl, ctx)
              : capabilities.attachUpload === true
                ? await uploadPastedImage(api, ctx, serverId, dataUrl)
                : pastedImageAttachment(dataUrl, serverId);
            if (attachment) prompt.attachments.push(attachment);
          } catch (error) {
            toasts.error(error instanceof Error ? error.message : "Couldn't attach pasted image");
          }
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
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

  {#if attachments.length > 0}
    <div class="-ml-1 pt-1.5">
      <AttachmentChips
        {attachments}
        tabId={targetTabId}
        onRemove={(id) => {
          const index = attachments.findIndex((a) => a.id === id);
          if (index !== -1) attachments.splice(index, 1);
        }}
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
        class="flex shrink-0 items-center gap-1 {isMobile
          ? 'pb-0.5'
          : 'pb-1.5'}"
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
      {prompt}
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
  {@render voiceButtons()}
  {@render sendButton()}
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
        sessionId={sessionId ?? undefined}
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
          <button
            {...tooltipProps}
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
            ? {
                label: "Steer this response · Queue next with ⌥Enter",
                shortcut: "Enter",
              }
            : isBusy
              ? "Queue message (Enter)"
              : willStartNewTask
                ? "Send (Enter) · Start another task (Ctrl+Enter)"
                : "Send (Enter)"}
      />
    </TooltipUI.Root>
  {/if}
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
