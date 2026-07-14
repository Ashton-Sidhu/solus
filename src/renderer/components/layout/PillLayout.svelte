<script lang="ts">
  import { onMount } from "svelte";
  import TabStrip from "./TabStrip.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import InputBarRow from "../input/InputBarRow.svelte";
  import StatusBarControls from "./StatusBarControls.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getPlanStore } from "../../contexts/plan.store.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import NewTabHome from "./NewTabHome.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
  }
  let { onAttachFile, onScreenshot, onDesignMode }: Props = $props();

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
  const noTabs = $derived(session.tabOrder.length === 0 && !session.plansGalleryOpen && !session.folioGalleryOpen && !session.settingsOpen);
  const pillPlanModal = $derived.by(() => {
    const planId = session.artifactViewer.activePlanId;
    const plan = planId ? planStore.get(planId) : planStore.previewPlan;
    if (!plan?.content.trim()) return null;
    return plan;
  });
  const pillWorkModal = $derived.by(() => {
    const workId = session.artifactViewer.activeWorkId;
    return workId ? session.worksStore.get(workId) : null;
  });
  const showPillDiagram = $derived(
    !!pillWorkModal && !isEditorMode && pillWorkModal.type === "diagram",
  );
  let inputFocused = $state(false);
  const pickerOpen = $derived(!isEditorMode && session.sessionPickerOpen);

  // Main keeps a first-summon pill window hidden until the actual layout—not
  // App's full-window async fallback—has mounted and can receive input.
  onMount(() => window.solusNative.rendererReady("pill"));

  // Galleries own their enter/exit behavior and retain local filters between
  // opens. Mount each on first use, then leave it alive; the module import and
  // component tree are both absent from a typical conversation-only launch.
  const mountedGalleries = new SvelteSet<"plans" | "folio">();
  $effect(() => {
    if (session.plansGalleryOpen) mountedGalleries.add("plans");
    if (session.folioGalleryOpen) mountedGalleries.add("folio");
  });

  // Lazy-mount the pill conversation pool. Only create a tab's ConversationView
  // the first time it becomes active, rather than mounting all N at once.
  const mountedTabIds = new SvelteSet<string>([session.activeTabId].filter(Boolean));
  $effect(() => {
    if (session.activeTabId) mountedTabIds.add(session.activeTabId);
    for (const id of mountedTabIds) {
      if (!session.tabs[id]) mountedTabIds.delete(id);
    }
  });

  $effect(() => {
    const handler = () => {
      if (isEditorMode) return;
      const next = !session.sessionPickerOpen;
      session.sessionPickerOpen = next;
      if (next) {
        session.isExpanded = true;
        session.plansGalleryOpen = false;
      }
    };
    window.addEventListener("solus:toggle-session-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-picker", handler);
  });

  async function duplicatePillWork(workId: string) {
    const duplicated = await session.worksStore.duplicate(workId);
    session.artifactViewer.openWork(duplicated.id);
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
      margin-bottom:{isExpanded ? 10 : -14}px;
      background:{isExpanded ? 'var(--solus-pill-opaque-bg)' : 'transparent'};
      box-shadow:{isExpanded ? 'var(--solus-card-shadow)' : 'none'};
      border:0.0625rem solid {isExpanded
        ? 'var(--solus-container-border)'
        : 'transparent'};
      border-radius:1.25rem;
      position:relative;
      z-index:{isExpanded ? 20 : 10};
      backdrop-filter:none;
      -webkit-backdrop-filter:none;
      transition:background 0.28s cubic-bezier(0.16,1,0.3,1), box-shadow 0.28s cubic-bezier(0.16,1,0.3,1), margin-bottom 0.28s cubic-bezier(0.16,1,0.3,1), border-color 0.28s cubic-bezier(0.16,1,0.3,1);
    "
    >
      <div
        class="overflow-hidden no-drag"
        style="
        height:{isExpanded ? 'auto' : 0};
        opacity:{isExpanded ? 1 : 0};
        transition:height 0.28s cubic-bezier(0.16,1,0.3,1), opacity 0.28s cubic-bezier(0.16,1,0.3,1);
      "
      >
        {#if session.settingsOpen}
          <div style="height:var(--pill-body-max);overflow:hidden">
            {#await import("../settings/SettingsPage.svelte")}
              {@render loadingSurface("Loading settings…")}
            {:then settingsModule}
              {@const SettingsPage = settingsModule.default}
              <SettingsPage />
            {/await}
          </div>
        {:else}
          {#if mountedGalleries.has("plans")}
            {#await import("../plan/PlanGallery.svelte")}
              {@render loadingSurface("Loading plans…")}
            {:then planGalleryModule}
              {@const PlanGallery = planGalleryModule.default}
              <PlanGallery />
            {/await}
          {/if}
          {#if mountedGalleries.has("folio")}
            {#await import("../artifact/FolioGallery.svelte")}
              {@render loadingSurface("Loading works…")}
            {:then folioGalleryModule}
              {@const FolioGallery = folioGalleryModule.default}
              <FolioGallery />
            {/await}
          {/if}
          {#if session.automationsOpen}
            <div style="height:var(--pill-body-max);overflow:hidden;display:flex;flex-direction:column">
              {#await import("../automations/AutomationsPage.svelte")}
                {@render loadingSurface("Loading automations…")}
              {:then automationsModule}
                {@const AutomationsPage = automationsModule.default}
                <AutomationsPage />
              {/await}
            </div>
          {/if}
          {#if session.tasksOpen}
            <div class="flex flex-col overflow-hidden h-[var(--pill-body-max)]">
              {#await import("../tasks/TasksPage.svelte")}
                {@render loadingSurface("Loading tasks…")}
              {:then tasksModule}
                {@const TasksPage = tasksModule.default}
                <TasksPage />
              {/await}
            </div>
          {/if}
          {#if session.prsOpen}
            <div class="flex flex-col overflow-hidden h-[var(--pill-body-max)]">
              {#await import("../prs/PrsPage.svelte")}
                {@render loadingSurface("Loading pull requests…")}
              {:then prsModule}
                {@const PrsPage = prsModule.default}
                <PrsPage />
              {/await}
            </div>
          {/if}
          {#if !session.plansGalleryOpen && !session.folioGalleryOpen && !session.automationsOpen && !session.tasksOpen && !session.prsOpen}
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
              <div style="{showPillDiagram ? 'height:var(--pill-body-max)' : 'max-height:var(--pill-body-max)'}">
                {#if showPillDiagram}
                  {#await import("../diagram/DiagramShell.svelte")}
                    {@render loadingSurface("Loading diagram…")}
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
                <div class:tab-hidden={showPillDiagram}>
                  {#if noTabs}
                    <NewTabHome />
                  {/if}
                  {#each session.tabOrder as tId (tId)}
                    {#if mountedTabIds.has(tId)}
                      <div
                        class="tab-slot [contain-intrinsic-size:auto_37.5rem] [content-visibility:auto]"
                        class:tab-hidden={tId !== session.activeTabId}
                      >
                        <ConversationView tabId={tId} />
                      </div>
                    {/if}
                  {/each}
                </div>
              </div>
              {#if pillWorkModal && !isEditorMode && pillWorkModal.type !== "diagram"}
                {#await import("../document-modal/DocumentModal.svelte")}
                  {@render loadingSurface("Loading document…")}
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
                  {@render loadingSurface("Loading plan…")}
                {:then planModalModule}
                  {@const PlanModal = planModalModule.default}
                  <PlanModal plan={pillPlanModal} />
                {/await}
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

        <InputBarRow
          mode="pill"
          {onAttachFile}
          {onScreenshot}
          {onDesignMode}
        />

        <div class="border-t border-(--solus-container-border)">
          <StatusBarControls />
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
