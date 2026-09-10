<script lang="ts">
  import { untrack } from "svelte";
  import { useComposerCommands } from "./lib/composer-commands.svelte";
  import {
    CornerDownRight as ArrowBendDownRightIcon,
    ArrowUp as ArrowUpIcon,
    Square as StopIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getStatusBarContext,
    getSettingsContext,
    getAgentContext,
    getVoiceModelStore,
    runtime,
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
  import type {
    PlanReference,
    Prompt,
    PromptDelivery,
    PluginCommandsResult,
    RunConfig,
    WorkReference,
    SessionReference,
  } from "@solus/contracts/types";
  import {
    isSteerableStatus,
    worktreeProjectRoot,
  } from "@solus/contracts/types";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { isMac } from "../../lib/keybindings/match";
  import { comboHint } from "../../lib/keybindings/manifest";
  import AttachmentChips from "./AttachmentChips.svelte";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import {
    parseAnnotationAttachmentId,
    removeMarkFromAttachment,
  } from "../browser/lib/annotation-attachment";
  import SavedPromptsControl from "./SavedPromptsControl.svelte";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import WaveformVisualizer from "./WaveformVisualizer.svelte";
  import RecordingControls from "./RecordingControls.svelte";
  import { dictation } from "../../lib/dictation.svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useComposerVoice } from "./lib/composer-voice.svelte";
  import { formatReleaseTime } from "../conversation/lib/queued-prompts";
  import { useComposerFocus } from "./lib/composer-focus.svelte";
  import { pendingPlanForPrompt } from "./lib/pending-plan";
  import {
    pendingQuestionForPrompt,
  } from "./lib/pending-question";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { useComposerFold } from "./lib/composer-fold.svelte";

  import type { Snippet } from "svelte";

  interface Props {
    active: boolean;
    maxHeight?: number;
    spacious?: boolean;
    onSent?: () => void;
    /** The conversation this bar composes for, or `null` when nothing has
     *  started behind it — a session draft. The bar is addressed by session and
     *  looks its tab up from that; it never resolves a session from whichever
     *  tab happens to be active, which a draft would answer wrongly. */
    sessionId: string | null;
    /** The tab this bar is docked beside, when it is docked beside one. Only
     *  view routing uses it — two tabs can watch one session, and quotes and
     *  file browsers belong to the pane the user is looking at. */
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
    /** How a draft's run is edited. The draft owns that object, so the change
     *  goes back to its owner rather than being written through the prop — the
     *  same seam the model and mode chips use. A started session leaves this
     *  unset: its run belongs to the store, which edits it in place. */
    onRun?: (next: RunConfig) => void;
    /** The draft this bar composes for, when no session exists yet. Host-side
     *  per-conversation storage — an attachment upload — is addressed by it, so
     *  a pasted image lands in the draft's own folder rather than failing for
     *  want of a session or landing in whichever session happens to be active. */
    draftId?: string;
    /** Commands resolved for this composer. Drafts supply their picker-scoped
     *  result because they have no session cache of their own. */
    pluginCommands?: PluginCommandsResult;
    /** The unsent message this bar edits. Passed in rather than resolved here,
     *  so the bar never needs to know whether it belongs to a conversation or to
     *  a composer that has no session yet. Mutated in place. */
    prompt: Prompt;
    /** Where Send goes when there is no conversation behind this bar. A session
     *  draft supplies it; a chat leaves it unset and the message goes to the
     *  session as usual. Returns false to keep the prompt for another try. */
    onDispatch?: (text: string, delivery: PromptDelivery) => boolean;
    /** Send without going anywhere: the session starts in the background and
     *  this bar keeps composing for a fresh draft aimed at the same place. Only
     *  a draft supplies it, and supplying it is what puts ⌘Enter on the bar. */
    onDispatchInBackground?: (text: string) => boolean;
    /** Work attached before a draft becomes a session. Started sessions own
     *  this on the session itself; drafts pass it directly. */
    boundWorkId?: string | null;
    onUnbindWork?: () => void;
    /** Whether this bar folds while the keyboard is elsewhere (ADR-0027).
     *  A host with nothing behind the bar to give room to — the session draft
     *  pane, where the bar is the page — turns it off. */
    collapseWhenIdle?: boolean;
    /** Receives the saved-prompts control, which the toolbar seats in the left
     *  cluster beside the pickers rather than out with the mic and send: saving
     *  a prompt is a composer decision, not a send action. It is handed over as
     *  a snippet because every prop it needs is private to this bar. */
    leadingActions?: Snippet<[Snippet]>;
  }
  let {
    active,
    maxHeight = 140,
    spacious = false,
    onSent,
    sessionId,
    tabId,
    isPrimary = false,
    paneId,
    run,
    onRun,
    draftId,
    pluginCommands: suppliedPluginCommands,
    prompt = $bindable(),
    onDispatch,
    onDispatchInBackground,
    boundWorkId: draftBoundWorkId,
    onUnbindWork,
    collapseWhenIdle = true,
    leadingActions,
  }: Props = $props();


  const theme = getSettingsContext();
  const agent = getAgentContext();
  const voiceModel = getVoiceModelStore();
  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
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
  const pendingPlan = $derived(
    pendingPlanForPrompt(sess, session.planStore.plans),
  );
  const pendingQuestion = $derived(pendingQuestionForPrompt(sess));
  // Not a width question. The four things that used to read `isMobileViewport`
  // here each ask about the *hand* or the *keyboard*: whether there is an Escape
  // key to stop a run, whether ⌥Enter is spellable, and how big a hit target has
  // to be. A window is not evidence for any of them — an iPad with a Magic
  // Keyboard has a small window and a full keyboard, and a phone in a wide
  // landscape window still has neither. Width itself is now the composer
  // disclosure ladder's job (see InputToolbar).
  const hasKeyboard = $derived(runtime.hasKeyboardPointer);
  const isTouch = $derived(runtime.isTouchDevice);
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
    active &&
      isFocusedPaneComposer &&
      (paneId !== undefined || isPrimary) &&
      !!run &&
      !isReadOnly,
  );
  const attachments = $derived(prompt.attachments);

  /**
   * A browser annotation is one chip per mark, so removing a chip removes one
   * mark — not the whole thing the user marked up. It also clears that mark
   * from the page, so the pane and the draft never disagree about what is
   * marked. The guest call is best-effort: the page may already be closed, in
   * which case the draft is the only copy left and updating it is the point.
   */
  function removeAnnotationMark(attachmentId: string, markId: string) {
    const index = attachments.findIndex((a) => a.id === attachmentId);
    if (index === -1) return;
    const next = removeMarkFromAttachment(attachments[index], markId);
    if (next) attachments[index] = next;
    else attachments.splice(index, 1);

    const page = parseAnnotationAttachmentId(attachmentId);
    if (!page) return;
    void browserStore
      .annotate(browserStore.keyOf(page.serverId, page.browserPageId), {
        kind: "remove",
        annotationId: markId,
      })
      .catch(() => {});
  }
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  const pluginCommands = $derived(
    suppliedPluginCommands ?? sess?.pluginCommands ?? session.pluginCommands,
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
  const composerServerId = $derived(
    run?.serverId ?? serverConnections.defaultServerId(),
  );

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
    if (!active) frozenText = untrack(() => prompt.text);
  });
  const editorValue = $derived(active ? prompt.text : frozenText);
  let composerEl: ReturnType<typeof PromptEditor> | null = $state(null);
  // The draft route stays mounted while its draft id changes. The editor then
  // receives a different prompt object without an input event, so explicitly
  // retire any trigger state that belonged to the previous draft.
  let autocompletePrompt = untrack(() => prompt);
  $effect(() => {
    const nextPrompt = prompt;
    if (nextPrompt === autocompletePrompt) return;
    autocompletePrompt = nextPrompt;
    untrack(() => composerEl?.clearCompletions());
  });
  /** The composer card — the saved-prompts sheet matches its width. */
  let composerRootEl = $state<HTMLElement | null>(null);

  // ─── Voice recorder ───

  const voice = dictation;
  const voiceOwnerId = $props.id();
  const commands = useComposerCommands(() => ({
    isReadOnly, isConnecting, isTouch, run, prompt, sessionId, targetTabId,
    draftId, composerCwd, pluginCommands, onDispatch, onDispatchInBackground,
    onSent, editor: composerEl, refocusComposer,
  }));
  const { handleSend, handleSolusCommand, stopRun, handleKeyDown, handleEditorChange, handlePaste } = commands;

  // Initialize voice before the fold below. The fold creates its collapsed
  // derived value immediately and reads `micHoldsBarOpen` through its recording
  // getter; reversing these two controllers puts that value in the temporal
  // dead zone while a draft pane mounts.
  const composerVoice = useComposerVoice({
    ownerId: voiceOwnerId,
    active: () => active,
    isPrimary: () => isPrimary,
    isReadOnly: () => isReadOnly,
    isConnecting: () => isConnecting,
    isBusy: () => isBusy,
    text: () => inputText,
    editor: () => composerEl,
    sendPrompt: commands.sendPrompt,
  });
  const ownsVoice = $derived(composerVoice.ownsVoice);
  const voiceState = $derived(composerVoice.state);
  const hasMountedWaveform = $derived(composerVoice.hasMountedWaveform);
  const showWaveform = $derived(composerVoice.showWaveform);
  const voiceControlState = $derived(composerVoice.controlState);
  const micHoldsBarOpen = $derived(composerVoice.holdsBarOpen);
  const claimVoice = composerVoice.claim;
  const toggleVoice = composerVoice.toggle;

  // ─── Idle collapse (ADR-0027) ───

  // Mic and send are pinned to the card's corner, out of flow, so the toolbar
  // and the idle text well are told how much corner to keep clear.
  let actionsWidth = $state(0);
  let actionsHeight = $state(0);

  const fold = useComposerFold({
    root: () => composerRootEl,
    tabId: () => targetTabId,
    enabled: () => collapseWhenIdle,
    recording: () => micHoldsBarOpen,
    claimVoice: () => claimVoice(true),
  });
  const isCollapsed = $derived(fold.collapsed);

  // ─── Derived state ───

  // Editor emptiness, updated synchronously by the editor on every
  // keystroke — unlike `inputText`, which only reflects the 200ms-debounced
  // markdown emit. Seeding from `inputText` at mount/tab-switch is safe
  // because PromptEditor immediately reports the true state once its `value`
  // prop lands.
  let editorHasText = $state(untrack(() => inputText.trim().length > 0));
  const planRefs = $derived(prompt.planRefs);
  const workRefs = $derived(prompt.workRefs);
  const sessionRefs = $derived(prompt.sessionRefs);
  const hasContent = $derived(
    editorHasText ||
      attachments.length > 0 ||
      planRefs.length > 0 ||
      workRefs.length > 0 ||
      sessionRefs.length > 0,
  );
  const canSend = $derived(!isConnecting && !isReadOnly && hasContent);
  // A device with no keyboard has no Escape key, so the only way to stop a run
  // would be to open a menu. The corner already holds "the next thing you can
  // do", and with an empty composer during a turn that is stopping it — the
  // instant anything is typed the button is a Send (or a Steer) again, so
  // nothing is taken away.
  const stopsRun = $derived(isTouch && !hasKeyboard && isBusy && !hasContent);
  // Work this session is actively collaborating on — its content is injected
  // into each prompt so the agent revises the live version.
  const boundWork = $derived.by(() => {
    const workId = sess?.boundWorkId ?? draftBoundWorkId;
    return workId ? session.worksStore.get(workId) : null;
  });
  function unbindWork() {
    if (sess) sess.boundWorkId = null;
    else onUnbindWork?.();
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
    if (voice.errorKind === "transient" && composerVoice.retryExhausted)
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
                        ? // Only name the keys where there are keys to name.
                          hasKeyboard
                          ? "Enter to steer now · ⌥Enter to queue next"
                          : "Send to steer this response..."
                        : "Type to queue a message..."
                    : "Plan, Build, Automate · @ for context",
  );

  // ─── Focus management ───

  function refocusComposer() {
    if (isPrimary) requestInputFocus();
    else composerEl?.focus();
  }

  useComposerFocus({
    active: () => active,
    isPrimary: () => isPrimary,
    isReadOnly: () => isReadOnly,
    ownsVoice: () => ownsVoice,
    voiceState: () => voiceState,
    showWaveform: () => showWaveform,
    session: () => sess,
    editor: () => composerEl,
    prompt: () => prompt,
    tabId: () => targetTabId,
    receivesFocusedInput: () => receivesFocusedInput,
    isFocusedPaneComposer: () => isFocusedPaneComposer,
    refocusComposer,
  });

  // ─── Model / mode shortcuts ───

  // Both land on the very object the model and mode chips below read, so the
  // change reaches whatever this bar composes for without a tab lookup. A
  // started session's run is the store's own object and is written in place,
  // exactly as `setPermissionMode` does; a draft's belongs to the draft, so it
  // goes back through `onRun` rather than through this bar's prop.
  function cycleModel() {
    if (!run || isBusy) return;
    const metadata = agent.metadata[activeProvider] ?? agent.activeMetadata;
    const models = metadata?.models;
    if (!models || models.length === 0) return;
    const nextModelId = cycledModelId(run, models, metadata?.defaultModel ?? null);
    if (!nextModelId) return;
    const nextConfig = modelConfigForModel(run, nextModelId);
    if (onRun) onRun({ ...run, modelConfig: { ...run.modelConfig, ...nextConfig } });
    else Object.assign(run.modelConfig, nextConfig);
    track("model_changed", { via: "keybinding" });
    refocusComposer();
  }
  function cyclePermissionMode() {
    if (!run) return;
    const mode = nextPermissionMode(run.permissionMode);
    if (onRun) onRun({ ...run, permissionMode: mode });
    else run.permissionMode = mode;
    track("permission_mode_set", { mode, via: "keybinding" });
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
      onRun?.({
        ...run,
        provider: next.id,
        modelConfig: {
          ...run.modelConfig,
          modelId,
          reasoningEffort: clampReasoningEffort(
            next.id,
            modelId,
            run.modelConfig.reasoningEffort,
          ),
        },
      });
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
  //
  // Both pickers anchor to chips on the toolbar row, which an idle bar has
  // tucked away. Focusing the editor first — synchronously, not through the
  // rAF-deferred focus request — puts the row back in the same flush the
  // picker positions against, so it never anchors to a hidden trigger.
  useKeybinding(
    "global.run-picker",
    () => {
      composerEl?.focus();
      window.dispatchEvent(
        new CustomEvent("solus:toggle-run-picker", {
          detail: { paneId: paneId ?? null },
        }),
      );
    },
    { enabled: () => ownsComposerShortcuts },
  );
  // The task chip sits in the same strip and answers the same way: the shortcut
  // names this composer's pane so only the picker beside this bar opens.
  useKeybinding(
    "global.session-task-picker",
    () => {
      composerEl?.focus();
      window.dispatchEvent(
        new CustomEvent("solus:toggle-session-task-picker", {
          detail: { paneId: paneId ?? null },
        }),
      );
    },
    { enabled: () => ownsComposerShortcuts },
  );
  // ─── Reference composer wiring ───

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

  /** Focus this exact composer. Route surfaces use this instead of broadcasting
   *  a workspace focus request that every mounted InputBar can hear. */
  export function focus() {
    composerEl?.focus();
  }

</script>

<!-- `contain: layout`, never `paint`. This box has no padding of its own, so its
     edges land exactly on the toolbar row: the send/stop button's right edge and
     the model chip's bottom edge sit on the clip line. Paint containment cut the
     stop button's outset ring off on the right and shaved the chip's hairline.
     The composer card one level out already clips, 12px further away, which is a
     boundary a control's border can survive. -->
<div
  bind:this={composerRootEl}
  class="flex flex-col w-full relative"
  style="contain:layout"
  onfocusin={fold.handleFocusIn}
  onfocusout={fold.handleFocusOut}
>
  {#if boundWork}
    <div class="flex pt-1.5">
      <div
        class="inline-flex items-center gap-1.5 rounded-lg bg-(--solus-accent-light) px-2 py-1 text-xs font-medium text-(--solus-accent) max-w-full"
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
    <div class="pt-2">
      <AttachmentChips
        {attachments}
        tabId={targetTabId}
        onRemove={(id) => {
          const index = attachments.findIndex((a) => a.id === id);
          if (index !== -1) attachments.splice(index, 1);
        }}
        onRemoveMark={removeAnnotationMark}
      />
    </div>
  {/if}

  {#if leadingActions}
    <!-- Two stacked zones in one card: a text well (its own vertical padding
         comes from the editor, symmetric so the first line sits centred in the
         well) and a toolbar row that never moves relative to the card's bottom
         edge. The well is inset a further 6px so prose clears the controls'
         optical left edge.

         Idle (ADR-0027), the same two boxes lie side by side instead: the
         toolbar is hidden — never unmounted, so every picker keeps its state —
         and mic and send sit at the end of the well's line. The editor stays
         put through the flip; only classes change. Mic and send are pinned
         to the card's bottom-right corner in both states, so they never move
         between two rows. The toolbar and the well each keep the corner clear
         through `--composer-actions-width`. -->
    <div
      class="relative flex w-full flex-col"
      style:--composer-actions-width="{actionsWidth}px"
      style:--composer-actions-height="{actionsHeight}px"
    >
      <div class="min-w-0 px-1.5">
        {@render editorOrWaveform()}
      </div>
      <!-- No `zoom` here, deliberately. It put this row in a different
           coordinate space from the `composer` container querying it, so the
           disclosure ladder in InputToolbar would fire at the wrong widths — at
           a 1.15 text preference a 26rem card holds only ~22.6rem of row. The
           row takes the `text-workspace-chrome` rung instead, which is what
           ADR-0013 says chrome should do: the text preference grows prose
           relative to controls, not with them.

           The row is at least as tall as the pinned buttons, so they sit
           inside it at rest rather than up into the well.

           Grid rows 0fr↔1fr fold the row in one step with the text well.
           composer-fold.ts animates the card and the row's arrival or exit. `inert`
           and `invisible` keep a folded row out of the Tab order, so the
           pickers are folded, never unmounted — every picker keeps its state.
           Rings need no room here: the chips draw none outside their box. -->
      <div
        data-composer-toolbar
        class="grid {isCollapsed
          ? 'invisible grid-rows-[0fr]'
          : 'visible grid-rows-[1fr]'}"
        inert={isCollapsed}
      >
        <div class="min-h-0 overflow-hidden">
          <div
            class="flex items-center pr-[calc(var(--composer-actions-width)_+_0.5rem)] min-h-(--composer-actions-height)"
          >
            {@render leadingActions(savedPromptsControl)}
          </div>
        </div>
      </div>
      <!-- The wider touch gap keeps the mic's and send's 44px tap areas from
           overlapping; see the `pointer-coarse:tap-area` utility. Last in the
           DOM so Tab still runs toolbar → mic → send. -->
      <div
        data-composer-actions
        bind:clientWidth={actionsWidth}
        bind:clientHeight={actionsHeight}
        class="absolute bottom-0 right-0 flex shrink-0 items-center gap-1 pointer-coarse:gap-2"
      >
        {@render actionButtons()}
      </div>
    </div>
  {:else}
    <div class="flex items-end w-full gap-2">
      <div class="flex-1 min-w-0">
        {@render editorOrWaveform()}
      </div>
      <!-- No `zoom` here either. Removing it from the editor branch alone would
           leave the same coordinate-space mismatch in the same component, and
           mic and send are chrome: the text preference grows prose relative to
           the controls, not with them (ADR-0013). -->
      <div
        class="flex shrink-0 items-center gap-1 pointer-coarse:gap-2 {isTouch
          ? 'pb-0.5'
          : 'pb-1.5'}"
      >
        {@render actionButtons()}
      </div>
    </div>
  {/if}
</div>

{#snippet savedPromptsControl()}
  <!-- No width guard here: rung 1 of the composer ladder hides this below 30rem,
       which is the same answer without the unmount. The phone never reached this
       branch anyway — it passes its own `leadingActions`, which takes no
       arguments and so never renders this snippet. -->
  <SavedPromptsControl
    {prompt}
    tabId={targetTabId}
    projectRoot={composerProjectRoot}
    serverId={composerServerId}
    active={active && receivesFocusedInput}
    {isReadOnly}
    anchorEl={composerRootEl}
    onClearEditor={() => composerEl?.clearEditor()}
    onRefocus={refocusComposer}
  />
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
       text well it replaces — entering voice mode must not resize the card.

       The well is generous at rest and one tight line while idle. The idle
       well is deliberately lopsided — 4px under the line — because the card
       keeps its 12px bottom padding either way: 16 above and 4 + 12 below is
       the line centred in the card, and the pinned buttons, whose centre sits
       15px above that same edge, land on the line too. A symmetric well here
       put the text visibly high with dead space under it. The idle well also
       keeps the corner clear on the right, where those buttons now sit on its
       line. With chips above, the top is tightened in every case so the well
       does not add a second gap under them.

       The well's padding changes in one step; the tween slides the well
       from its previous position as the card changes height. -->
  <div
    data-composer-prompt
    class="[--plain-editor-font-size:var(--text-workspace-chrome)] [--plain-editor-line-height:1.5] [--solus-font-weight-body:var(--solus-font-weight-user-content)] {isCollapsed
      ? spacious
        ? attachments.length > 0
          ? '[--plain-editor-padding:0.5rem_calc(var(--composer-actions-width)_+_0.5rem)_0.25rem_0]'
          : '[--plain-editor-padding:1rem_calc(var(--composer-actions-width)_+_0.5rem)_0.25rem_0]'
        : attachments.length > 0
          ? '[--plain-editor-padding:0.5rem_calc(var(--composer-actions-width)_+_0.5rem)_0.25rem_0.25rem]'
          : '[--plain-editor-padding:0.9375rem_calc(var(--composer-actions-width)_+_0.5rem)_0.25rem_0.25rem]'
      : spacious
        ? attachments.length > 0
          ? '[--plain-editor-padding:0.5rem_0_1.25rem_0]'
          : '[--plain-editor-padding:1.25rem_0_1.25rem_0]'
        : attachments.length > 0
          ? '[--plain-editor-padding:0.5rem_0_0.9375rem_0.25rem]'
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
        serverId={run?.serverId}
        sessionId={sessionId ?? undefined}
        workingDirectory={composerCwd}
        onRefsChange={handleRefsChange}
        includeSolusCommands
        onSolusCommand={handleSolusCommand}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        {placeholder}
        readOnly={isReadOnly}
        disabled={isReadOnly || voiceState === "transcribing"}
        maxHeight={maxHeight}
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
            onclick={() => (stopsRun ? stopRun() : handleSend())}
            disabled={!canSend && !stopsRun}
            data-testid={stopsRun ? "stop-button" : "send-button"}
            aria-label={stopsRun
              ? "Stop this run"
              : canSteer
                ? "Steer the live turn"
                : "Send message"}
            class="pointer-coarse:tap-area flex shrink-0 items-center justify-center rounded-lg transition-[background-color,box-shadow,transform] duration-150 enabled:active:scale-[0.96] {isTouch
              ? 'size-9'
              : 'size-[1.875rem] [.is-laptop-display_&]:size-7'} {stopsRun
              ? ''
              : canSend
                ? 'bg-(--solus-accent) text-(--solus-text-on-accent) shadow-[0_0.25rem_0.75rem_-0.375rem_var(--solus-send-glow)] hover:shadow-[0_0.3125rem_0.875rem_-0.375rem_var(--solus-send-glow)]'
                : 'cursor-default bg-(--solus-surface-active) text-(--solus-text-tertiary)'}"
            style={stopsRun
              ? "box-shadow:0 0 0 0.03125rem color-mix(in oklch, var(--failure) 45%, transparent);color:color-mix(in oklch, var(--failure) 70%, var(--foreground))"
              : undefined}
          >
            {#if stopsRun}
              <StopIcon size={12} fill="currentColor" strokeWidth={0} />
            {:else if canSteer && canSend}
              <ArrowBendDownRightIcon size={14} strokeWidth={3} />
            {:else}
              <ArrowUpIcon size={14} strokeWidth={3} />
            {/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={stopsRun
          ? "Stop this run"
          : !canSend
          ? null
          : canSteer
            ? {
                label: "Steer this response · Queue next with ⌥Enter",
                shortcut: "Enter",
              }
            : isBusy
              ? "Queue message (Enter)"
              : onDispatchInBackground
                ? `Send (Enter) · Start in the background and keep composing (${isMac ? "⌘" : "Ctrl+"}Enter)`
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
    showMic={voiceModel.supported && !isTouch}
    disabled={isConnecting || isReadOnly || !voiceModel.ready}
    progressPct={!voiceModel.ready ? voiceModel.progressPct : null}
    idleTooltip={idleVoiceTooltip}
    onCancel={() => voice.cancel()}
    onConfirm={() => voice.stop()}
    onToggle={toggleVoice}
  />
{/snippet}
