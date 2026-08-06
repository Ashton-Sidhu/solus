<script lang="ts">
  import { onMount } from "svelte";
  import TabStrip from "./TabStrip.svelte";
  import GoalSection from "../project-panel/GoalSection.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import InputBar from "../input/InputBar.svelte";
  import InputToolbar from "../input/InputToolbar.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getWorkspaceContext, getPlanStore, getWindowContext } from "../../contexts";
  import PaneChrome from "../ui/PaneChrome.svelte";
  // Eager, unlike the surfaces below: these are what cover an async boundary,
  // so they cannot sit behind one themselves.
  import PlanModalSkeleton from "../plan/PlanModalSkeleton.svelte";
  import DocumentModalSkeleton from "../document-modal/DocumentModalSkeleton.svelte";
  import DiagramShellSkeleton from "../diagram/DiagramShellSkeleton.svelte";
  import SettingsPageSkeleton from "../settings/SettingsPageSkeleton.svelte";
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
  const windowCtx = getWindowContext();

  const clamp = (v: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, v)));

  const isLaptop = $derived(windowCtx.workAreaWidth < 1800);
	  const pillWidth = $derived(
	    isLaptop
	      ? clamp(windowCtx.workAreaWidth * 0.67, 620, 960)
	      : clamp(windowCtx.workAreaWidth * 0.82, 900, 1440),
	  );
  const pillBodyMax = $derived(
    isLaptop
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
  const pillGoalTabId = $derived(router.params("goal")?.tabId ?? null);
  let pillGoalCollapsed = $state(false);
  let inputFocused = $state(false);
  const pickerOpen = $derived(!isEditorMode && session.sessionPickerOpen);

  // A tab that has not started a conversation has nothing above the bar to
  // show, so a new tab leaves the pill as just the bar rather than opening onto
  // an empty body. Any surface that fills the body on its own still opens it.
  const pillSession = $derived(session.sessionFor(session.activeTabId));
  const pillHomeVisible = $derived(!pillSession || isHomeVisible(pillSession));
  const pillSurfaceOpen = $derived(
    router.at("settings") ||
      router.at("folio") ||
      router.at("automations") ||
      router.at("tasks") ||
      router.at("prs") ||
      pickerOpen ||
      !!pillGoalTabId ||
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
      <div
        class="overflow-hidden no-drag"
        style="
        height:{bodyOpen ? 'auto' : 0};
        opacity:{bodyOpen ? 1 : 0};
        transition:height 0.28s cubic-bezier(0.16,1,0.3,1), opacity 0.28s cubic-bezier(0.16,1,0.3,1);
      "
      >
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
                {@render loadingSurface("Loading pull requests…")}
              {:then prsModule}
                {@const PrsPage = prsModule.default}
                <PrsPage />
              {/await}
            </div>
          {/if}
          {#if !router.at("folio") && !router.at("automations") && !router.at("tasks") && !router.at("prs")}
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
            {:else}
              <div class="relative" style="{showPillDiagram || pillGoalTabId ? 'height:var(--pill-body-max)' : 'max-height:var(--pill-body-max)'}">
                {#if pillGoalTabId}
                  <PaneChrome
                    onClose={() => { router.close("goal"); requestInputFocus() }}
                    closeLabel="Close goal"
                  />
                  <!-- The pill has no project rail, so the goal card the rail
                       hosts in editor mode fills the pill body instead. -->
                  <div class="h-full overflow-y-auto p-2 pt-10">
                    <GoalSection
                      tabId={pillGoalTabId}
                      collapsed={pillGoalCollapsed}
                      onToggle={() => (pillGoalCollapsed = !pillGoalCollapsed)}
                      onCleared={() => { router.close("goal"); requestInputFocus() }}
                    />
                  </div>
                {/if}
                {#if showPillDiagram}
                  <!-- The diagram renders in the pill body rather than as a
                       portaled modal, so its close lives in the shared pane
                       chrome cluster like it does in editor mode. -->
                  <PaneChrome
                    onClose={() => { session.closeWorkModal(); requestInputFocus() }}
                    closeLabel="Close diagram"
                  />
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
                {/if}
                <!-- Persistent conversation pool: hidden (not unmounted) while a
                     diagram overlays, so closing it reveals the conversation
                     instantly with all state preserved. -->
                <div class:tab-hidden={showPillDiagram || !!pillGoalTabId}>
                  {#each session.tabOrder as tId (tId)}
                    {#if mountedTabIds.has(tId)}
                      <div
                        class="tab-slot [contain-intrinsic-size:auto_37.5rem] [content-visibility:auto]"
                        class:tab-hidden={tId !== session.activeTabId}
                      >
                        <ConversationView
                          tabId={tId}
                          surfaceVisible={active && !showPillDiagram && !pillGoalTabId}
                          retainTranscriptRows={retainedTranscriptTabIds.has(tId)}
                        />
                      </div>
                    {/if}
                  {/each}
                </div>
              </div>
              {#if pillWorkModal && !isEditorMode && pillWorkModal.type !== "diagram"}
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
              {:else if pillPlanModal && !isEditorMode}
                {#await import("../plan/PlanModal.svelte")}
                  <PlanModalSkeleton />
                {:then planModalModule}
                  {@const PlanModal = planModalModule.default}
                  <PlanModal plan={pillPlanModal} />
                {/await}
              {:else if pillPlanPending && !isEditorMode}
                <PlanModalSkeleton />
              {/if}
            {/if}
          {/if}
        {/if}
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
          <InputBar mode="pill" prompt={session.inputFor(session.activeTabId)}>
            {#snippet leadingActions()}
              <InputToolbar
                mode="pill"
                {onAttachFile}
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
</style>
