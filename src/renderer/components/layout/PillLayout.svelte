<script lang="ts">
  import { onMount } from "svelte";
  import TabStrip from "./TabStrip.svelte";
  import GoalSection from "../project-panel/GoalSection.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import InputBar from "../input/InputBar.svelte";
  import InputToolbar from "../input/InputToolbar.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import TaskPicker from "../session/TaskPicker.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    getWorkspaceContext,
    getPlanStore,
    getSettingsContext,
    getWindowContext,
    runtime,
  } from "../../contexts";
  import { draftModelSelection } from "../session-draft/lib/draft-selection";
  import PaneChrome from "../ui/PaneChrome.svelte";
  // Eager, unlike the surfaces below: these are what cover an async boundary,
  // so they cannot sit behind one themselves.
  import PlanModalSkeleton from "../plan/PlanModalSkeleton.svelte";
  import DocumentModalSkeleton from "../document-modal/DocumentModalSkeleton.svelte";
  import DiagramShellSkeleton from "../diagram/DiagramShellSkeleton.svelte";
  import SettingsPageSkeleton from "../settings/SettingsPageSkeleton.svelte";
  import PrsPageSkeleton from "../prs/PrsPageSkeleton.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { isHomeVisible, retainedConversationTabIds } from "./lib/workspace-body";

  interface Props {
    active?: boolean;
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
  }
  let { active = true, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const theme = getSettingsContext();
  const windowCtx = getWindowContext();

  const clamp = (v: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, v)));

  const pillWidth = $derived(
    runtime.isLaptopDisplay
      ? clamp(windowCtx.workAreaWidth * 0.67, 620, 960)
      : clamp(windowCtx.workAreaWidth * 0.82, 900, 1440),
  );
  const pillBodyMax = $derived(
    runtime.isLaptopDisplay
      ? clamp(windowCtx.workAreaHeight * 0.55, 400, 580)
      : clamp(windowCtx.workAreaHeight * 0.68, 540, 740),
  );
  const pillMargin = $derived(clamp(windowCtx.workAreaHeight * 0.025, 16, 48));
  const isExpanded = $derived(session.isExpanded);
  const isEditorMode = $derived(windowCtx.viewMode === "editor");
  const router = session.router;
  const pillPlanModal = $derived.by(() => {
    const planId = router.params("plan")?.planId ?? null;
    const plan = planId ? planStore.get(planId) : planStore.previewPlan;
    if (!plan?.content.trim()) return null;
    return plan;
  });
  // A plan surface is open on an id whose body has not arrived yet — the pane
  // opens first so the click has somewhere to land.
  const pillPlanPending = $derived(router.at("plan") && !pillPlanModal);
  const pillWorkModal = $derived.by(() => {
    const workId = router.params("work")?.workId;
    return workId ? session.worksStore.get(workId) : null;
  });
  const showPillDiagram = $derived(
    !!pillWorkModal && !isEditorMode && pillWorkModal.type === "diagram",
  );
  const pillGoalSessionId = $derived(router.params("goal")?.sessionId ?? null);
  let pillGoalCollapsed = $state(false);
  let inputFocused = $state(false);
  const pickerOpen = $derived(!isEditorMode && session.sessionPickerOpen);
  const taskPickerOpen = $derived(!isEditorMode && session.taskPickerOpen);
  // The pill has no route outlet: it renders one fixed set of surfaces, so a
  // draft reaches it as the thing its dock composes for rather than as a pane.
  // Without this the bar keeps speaking for the tab the draft covered, and a
  // new session started in the pill would send its first message into the last
  // conversation instead.
  // Read off the leading pane's own content rather than what is visible in it:
  // Settings or a plan layered over the draft still leaves the dock composing
  // for that draft, the same rule `composingDraftIds` follows.
  const pillDraft = $derived.by(() => {
    const base = router.leadingPane.base;
    return base?.name === "draft"
      ? (session.sessionDrafts.get(base.params.draftId) ?? null)
      : null;
  });
  const pillDraftSelection = draftModelSelection(
    () => pillDraft,
    () => session.defaultRunConfig.provider ?? theme.activeAgent,
  );
  let prompt = $derived(
    pillDraft ? pillDraft.prompt : session.inputFor(session.activeTabId),
  );

  // A tab that has not started a conversation has nothing above the bar to
  // show, so a new tab leaves the pill as just the bar rather than opening onto
  // an empty body. Any surface that fills the body on its own still opens it.
  const pillSession = $derived(session.sessionFor(session.activeTabId));
  const pillSnoozeReminder = $derived(
    session.tasksStore.snoozeReminderForSession(pillSession?.agentSessionId),
  );
  const pillHomeVisible = $derived(
    !!pillDraft || !pillSession || isHomeVisible(pillSession, !!pillSnoozeReminder),
  );
  const pillSurfaceOpen = $derived(
    router.at("settings") ||
      router.at("folio") ||
      router.at("automations") ||
      router.at("tasks") ||
      router.at("prs") ||
      pickerOpen ||
      taskPickerOpen ||
      !!pillGoalSessionId ||
      showPillDiagram ||
      !!pillWorkModal ||
      !!pillPlanModal ||
      pillPlanPending,
  );
  const bodyOpen = $derived(isExpanded && (pillSurfaceOpen || !pillHomeVisible));

  // Main keeps a first-summon pill window hidden until the actual layout—not
  // App's full-window async fallback—has mounted and can receive input.
  onMount(() => window.solusNative.rendererReady("pill"));

  // The workspace page owns its enter/exit behavior and retains filters between
  // opens. Mount on first use, then leave it alive; the module import and
  // component tree are both absent from a typical conversation-only launch.
  let hasMountedWorkspace = $state(false);
  $effect(() => {
    if (router.at("folio")) hasMountedWorkspace = true;
  });

  // The conversation pool outlives every covering surface. Unmounting it for a
  // picker, Settings, or a page toggle would force a full transcript remount
  // (markdown re-parse, entry animations, scroll reset) on the way back — so it
  // lazy-mounts once and then hides with display:none, like WorkspaceBody's pool.
  const conversationSurfaceActive = $derived(
    !router.at("settings") &&
      !router.at("folio") &&
      !router.at("automations") &&
      !router.at("tasks") &&
      !router.at("prs"),
  );
  const conversationPoolVisible = $derived(
    conversationSurfaceActive && !pickerOpen && !taskPickerOpen,
  );
  // Seeded from the current value so the common launch (straight into a
  // conversation) paints the pool on the very first frame.
  let hasMountedConversationPool = $state(conversationPoolVisible);
  $effect(() => {
    if (conversationPoolVisible) hasMountedConversationPool = true;
  });

  // Lazy-mount the pill conversation pool. Only create a tab's ConversationView
  // the first time it becomes active, rather than mounting all N at once.
  const mountedTabIds = new SvelteSet<string>([session.activeTabId].filter(Boolean));
  const retainedTranscriptTabIds = new SvelteSet<string>();
  const transcriptRecency: string[] = [];
  $effect(() => {
    const displayedTabIds =
      active && session.activeTabId && session.tabs[session.activeTabId]
        ? [session.activeTabId]
        : [];
    for (const id of displayedTabIds) mountedTabIds.add(id);
    for (const id of mountedTabIds) {
      if (!session.tabs[id]) mountedTabIds.delete(id);
    }

    const retained = active
      ? retainedConversationTabIds(
          transcriptRecency,
          displayedTabIds,
          session.tabOrder,
        )
      : [];
    transcriptRecency.splice(0, transcriptRecency.length, ...retained);
    for (const id of retained) retainedTranscriptTabIds.add(id);
    for (const id of retainedTranscriptTabIds) {
      if (!retained.includes(id)) retainedTranscriptTabIds.delete(id);
    }
  });

  $effect(() => {
    const handler = () => {
      if (isEditorMode) return;
      const next = !session.sessionPickerOpen;
      session.sessionPickerOpen = next;
      if (next) {
        session.isExpanded = true;
        router.close("folio");
      }
    };
    window.addEventListener("solus:toggle-session-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-picker", handler);
  });

  /**
   * Send is the moment the pill's draft stops being one: the session is
   * created, its tab mounts, and `createSession` hands the leading pane back to
   * the conversation pool. The prompt object goes into the new tab, so the text
   * the bar clears after this is the same object the send just read.
   */
  function startPillDraft(text: string): boolean {
    const draft = pillDraft;
    if (!draft) return false;
    const tabId = session.startSessionDraft(draft.id, { via: "click" });
    if (!tabId) return false;
    return session.sendMessage(text, undefined, tabId);
  }

  /** A draft has no tab for the workspace attach handler to address, so files
   *  picked while composing one land on the draft's own prompt. */
  async function attachPillDraftFile() {
    const draft = pillDraft;
    if (!draft) return;
    const files = await session
      .apiForRun(draft.run)
      .attachFiles(session.ctxForDirectory(draft.run.workingDirectory));
    if (!files || files.length === 0) return;
    for (const file of files) draft.prompt.attachments.push(file);
  }

  async function duplicatePillWork(workId: string) {
    const duplicated = await session.worksStore.duplicate(workId);
    session.openWork(duplicated.id);
    requestInputFocus();
  }
</script>

{#snippet loadingSurface(label: string)}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    {label}
  </div>
{/snippet}

<div
  class="click-through-shell fixed bottom-(--pill-margin) left-1/2 z-50 flex max-h-[calc(100vh-(var(--pill-margin)*2))] w-(--pill-width) -translate-x-1/2 flex-col justify-end"
  style="--pill-width:{pillWidth}px;--pill-body-max:{pillBodyMax}px;--pill-margin:{pillMargin}px"
>
  <div class="relative flex w-full flex-col" data-solus-ui>
    <div
      class="overflow-hidden flex flex-col no-drag"
      style="
      width:100%;
      margin-bottom:{bodyOpen ? 10 : -14}px;
      background:{bodyOpen ? 'var(--solus-pill-opaque-bg)' : 'transparent'};
      box-shadow:{bodyOpen ? 'var(--solus-card-shadow)' : 'none'};
      border:0.0625rem solid {bodyOpen
        ? 'var(--solus-container-border)'
        : 'transparent'};
      border-radius:1.25rem;
      position:relative;
      z-index:{bodyOpen ? 20 : 10};
      backdrop-filter:none;
      -webkit-backdrop-filter:none;
      transition:background 0.28s cubic-bezier(0.16,1,0.3,1), box-shadow 0.28s cubic-bezier(0.16,1,0.3,1), margin-bottom 0.28s cubic-bezier(0.16,1,0.3,1), border-color 0.28s cubic-bezier(0.16,1,0.3,1);
    "
    >
      <!-- height:0↔auto never interpolates, so the body used to snap while the
           card frame animated. Grid rows 0fr↔1fr animate the same collapse
           smoothly and stay interruptible mid-toggle. -->
      <div class="pill-body-reveal no-drag" class:pill-body-open={bodyOpen}>
        <div class="min-h-0 overflow-hidden flex flex-col">
        {#if router.at("settings")}
          <div style="height:var(--pill-body-max);overflow:hidden">
            {#await import("../settings/SettingsPage.svelte")}
              <SettingsPageSkeleton />
            {:then settingsModule}
              {@const SettingsPage = settingsModule.default}
              <SettingsPage />
            {/await}
          </div>
        {:else}
          {#if hasMountedWorkspace}
            {#await import("../workspace/WorkspacePage.svelte")}
              {@render loadingSurface("Loading workspace…")}
            {:then workspaceModule}
              {@const WorkspacePage = workspaceModule.default}
              <WorkspacePage />
            {/await}
          {/if}
          {#if router.at("automations")}
            <div style="height:var(--pill-body-max);overflow:hidden;display:flex;flex-direction:column">
              {#await import("../automations/AutomationsPage.svelte")}
                {@render loadingSurface("Loading automations…")}
              {:then automationsModule}
                {@const AutomationsPage = automationsModule.default}
                <AutomationsPage />
              {/await}
            </div>
          {/if}
          {#if router.at("tasks")}
            <div class="flex flex-col overflow-hidden h-[var(--pill-body-max)]">
              {#await import("../tasks/TasksPage.svelte")}
                {@render loadingSurface("Loading tasks…")}
              {:then tasksModule}
                {@const TasksPage = tasksModule.default}
                <TasksPage />
              {/await}
            </div>
          {/if}
          {#if router.at("prs")}
            <div class="flex flex-col overflow-hidden h-[var(--pill-body-max)]">
              {#await import("../prs/PrsPage.svelte")}
                <PrsPageSkeleton />
              {:then prsModule}
                {@const PrsPage = prsModule.default}
                <PrsPage />
              {/await}
            </div>
          {/if}
          {#if conversationSurfaceActive}
            {#if pickerOpen}
              <div
                class="flex flex-col"
                style="height:var(--pill-body-max);overflow:hidden"
              >
                <SessionPicker
                  inline
                  bind:open={session.sessionPickerOpen}
                  onClose={() => {
                    session.sessionPickerOpen = false;
                  }}
                />
              </div>
            {:else if taskPickerOpen}
              <div
                class="flex flex-col"
                style="height:var(--pill-body-max);overflow:hidden"
              >
                <TaskPicker
                  inline
                  bind:open={session.taskPickerOpen}
                  onClose={() => {
                    session.taskPickerOpen = false;
                  }}
                />
              </div>
            {/if}
          {/if}
        {/if}
        {#if hasMountedConversationPool}
          <div class:tab-hidden={!conversationPoolVisible}>
              <div class="relative" style="{showPillDiagram || pillGoalSessionId ? 'height:var(--pill-body-max)' : 'max-height:var(--pill-body-max)'}">
                {#if pillGoalSessionId}
                  <!-- The pill has no project rail, so the goal card the rail
                       hosts in editor mode fills the pill body instead. -->
                  <div class="h-full overflow-y-auto p-2 pt-10">
                    <GoalSection
                      sessionId={pillGoalSessionId}
                      collapsed={pillGoalCollapsed}
                      onToggle={() => (pillGoalCollapsed = !pillGoalCollapsed)}
                      onCleared={() => { router.close("goal"); requestInputFocus() }}
                    />
                  </div>
                  <PaneChrome
                    onClose={() => { router.close("goal"); requestInputFocus() }}
                    closeLabel="Close goal"
                  />
                {/if}
                {#if showPillDiagram}
                  <!-- The diagram renders in the pill body rather than as a
                       portaled modal, so its close lives in the shared pane
                       chrome cluster like it does in editor mode. The cluster
                       renders after the shell: its toolbar is a window drag
                       region, and a drag rect later in the DOM would re-cover
                       the cluster's no-drag holes. -->
                  {#await import("../diagram/DiagramShell.svelte")}
                    <DiagramShellSkeleton />
                  {:then diagramModule}
                    {@const DiagramShell = diagramModule.default}
                    <DiagramShell
                      content={pillWorkModal!.content}
                      title={pillWorkModal!.title}
                      workId={pillWorkModal!.id}
                      onSave={async (content) => { await session.worksStore.save(pillWorkModal!.id, { content }) }}
                      onDuplicate={() => duplicatePillWork(pillWorkModal!.id)}
                      onClose={() => { session.closeWorkModal(); requestInputFocus() }}
                    />
                  {/await}
                  <PaneChrome
                    onClose={() => { session.closeWorkModal(); requestInputFocus() }}
                    closeLabel="Close diagram"
                  />
                {/if}
                <!-- Persistent conversation pool: hidden (not unmounted) while a
                     diagram overlays, so closing it reveals the conversation
                     instantly with all state preserved. -->
                <div class:tab-hidden={showPillDiagram || !!pillGoalSessionId}>
                  {#each session.tabOrder as tId (tId)}
                    {#if mountedTabIds.has(tId)}
                      <div
                        class="tab-slot [contain-intrinsic-size:auto_37.5rem] [content-visibility:auto]"
                        class:tab-hidden={tId !== session.activeTabId}
                      >
                        <ConversationView
                          tabId={tId}
                          surfaceVisible={active && conversationPoolVisible && !showPillDiagram && !pillGoalSessionId}
                          retainTranscriptRows={retainedTranscriptTabIds.has(tId)}
                        />
                      </div>
                    {/if}
                  {/each}
                </div>
              </div>
              {#if conversationPoolVisible && pillWorkModal && !isEditorMode && pillWorkModal.type !== "diagram"}
                {#await import("../document-modal/DocumentModal.svelte")}
                  <DocumentModalSkeleton
                    title={pillWorkModal.title}
                    workStorage={pillWorkModal.storage}
                  />
                {:then documentModule}
                  {@const DocumentModal = documentModule.default}
                  <DocumentModal
                    document={{ title: pillWorkModal.title, content: pillWorkModal.content }}
                    workId={pillWorkModal.id}
                    onSave={async (content) => { await session.worksStore.save(pillWorkModal!.id, { content }) }}
                    onDuplicate={() => duplicatePillWork(pillWorkModal!.id)}
                    onClose={() => session.closeWorkModal()}
                  />
                {/await}
              {:else if conversationPoolVisible && pillPlanModal && !isEditorMode}
                {#await import("../plan/PlanModal.svelte")}
                  <PlanModalSkeleton />
                {:then planModalModule}
                  {@const PlanModal = planModalModule.default}
                  <PlanModal plan={pillPlanModal} />
                {/await}
              {:else if conversationPoolVisible && pillPlanPending && !isEditorMode}
                <PlanModalSkeleton />
              {/if}
          </div>
        {/if}
        </div>
      </div>
    </div>

    <div class="relative" style="z-index:15;margin-bottom:0.625rem">
      <div
        class="w-full overflow-hidden bg-(--solus-pill-opaque-bg)"
        onfocusin={() => (inputFocused = true)}
        onfocusout={() => (inputFocused = false)}
        style="
        border-radius:1.125rem;
        border:0.0625rem solid {inputFocused
          ? 'var(--solus-input-focus-border)'
          : 'var(--solus-container-border)'};
        box-shadow:{inputFocused
          ? `0 0 0 0.1875rem var(--solus-input-focus-ring), var(--solus-card-shadow)`
          : 'var(--solus-card-shadow)'};
        transition:box-shadow 0.18s ease, border-color 0.18s ease;
        backdrop-filter:none;
        -webkit-backdrop-filter:none;
      "
      >
        <TabStrip />

        <div class="px-1.5 pb-1.5 pt-1">
          <!-- Addressed by what it composes for: a draft has no session and no
               tab, so both go unset and Send mints them instead. -->
          <InputBar
            mode="pill"
            sessionId={pillDraft ? null : (session.activeSession?.id ?? null)}
            tabId={pillDraft ? undefined : session.activeTabId}
            isPrimary
            run={pillDraft ? pillDraft.run : session.activeSession?.run}
            onDispatch={pillDraft ? startPillDraft : undefined}
            bind:prompt
          >
            {#snippet leadingActions()}
              <InputToolbar
                mode="pill"
                tabId={pillDraft ? undefined : session.activeTabId}
                draftId={pillDraft?.id}
                isPrimary
                run={pillDraft ? pillDraft.run : undefined}
                onRun={pillDraft
                  ? (next) => {
                      if (pillDraft) pillDraft.run = next;
                    }
                  : undefined}
                selection={pillDraft ? pillDraftSelection : undefined}
                onAttachFile={pillDraft ? attachPillDraftFile : onAttachFile}
                {onScreenshot}
                {onDesignMode}
              />
            {/snippet}
          </InputBar>
        </div>
      </div>

    </div>
  </div>
</div>

<style>
  .tab-hidden {
    display: none !important;
  }
  .pill-body-reveal {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 0.28s cubic-bezier(0.16, 1, 0.3, 1),
      opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .pill-body-reveal.pill-body-open {
    grid-template-rows: 1fr;
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .pill-body-reveal {
      transition: none;
    }
  }
</style>
