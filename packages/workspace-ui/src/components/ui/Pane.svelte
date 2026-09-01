<script lang="ts">
  import type { PaneEntry } from "../../contexts/workspace/routing/location";
  import { visibleRef } from "../../contexts/workspace/routing/location";
  import { ROUTES } from "../../contexts/workspace/routing/route-registry";
  import type { PaneSurfaceProps } from "./lib/pane-surface";
  import { getWorkspaceContext } from "../../contexts";
  // Eager, unlike every surface below: these are what cover an async boundary,
  // so they cannot sit behind one themselves.
  import ConversationPaneSkeleton from "../conversation/ConversationPaneSkeleton.svelte";
  import SettingsPageSkeleton from "../settings/SettingsPageSkeleton.svelte";
  import PrReviewSkeleton from "../pr-review/PrReviewSkeleton.svelte";
  import TasksPageSkeleton from "../tasks/TasksPageSkeleton.svelte";
  import TaskPageSkeleton from "../tasks/task-page/TaskPageSkeleton.svelte";
  import AutomationsPageSkeleton from "../automations/AutomationsPageSkeleton.svelte";
  import AutomationBuilderSkeleton from "../automations/AutomationBuilderSkeleton.svelte";
  import InsightsPageSkeleton from "../insights/InsightsPageSkeleton.svelte";
  import ReviewLoadingSurface from "../review/ReviewLoadingSurface.svelte";
  import PlanModalSkeleton from "../plan/PlanModalSkeleton.svelte";
  import DocumentModalSkeleton from "../document-modal/DocumentModalSkeleton.svelte";
  import DiagramShellSkeleton from "../diagram/DiagramShellSkeleton.svelte";
  import FilesRouteSkeleton from "../files/FilesRouteSkeleton.svelte";
  // The draft composer is the primary creation path, not a data-backed page.
  // Keep it in the shell chunk so opening a draft never crosses an async
  // boundary or flashes a loading surface before the input is ready.
  import SessionDraftPane from "../session-draft/SessionDraftPane.svelte";
  // The PR page owns its one loading state. Keep it eager so the route outlet
  // cannot insert a second module-loading state before the data-loading state.
  import PrsPage from "../prs/PrsPage.svelte";
  import ListPageSkeleton from "./list-page/ListPageSkeleton.svelte";
  import RouteLoadError from "./RouteLoadError.svelte";
  import PaneChrome from "./PaneChrome.svelte";
  import { paneActions } from "./lib/pane-actions.svelte";

  /**
   * The route outlet: one pane, whatever route it currently shows. It knows
   * nothing about any destination — the registry says which module to load and
   * the surface owns its own chrome, so adding a destination touches no file
   * but the registry.
   */
  interface Props extends Omit<PaneSurfaceProps, "paneId"> {
    pane: PaneEntry;
  }

  let { pane, surfaceVisible = true, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const actions = paneActions(() => pane.id);
  const ref = $derived(visibleRef(pane));
  const descriptor = $derived(ref ? ROUTES[ref.name] : null);
  // Pages used to size themselves with `flex-1` as children of the content
  // column; a companion pane's wrapper is a block, so it needs the height.
  const isPage = $derived(descriptor?.exclusiveGroup === "page");
  const needsPageTopInset = $derived(
    isPage && descriptor?.ownsTitlebarChrome !== true,
  );
  const isLeading = $derived(session.router.leadingPane.id === pane.id);
  // Bumped by the error surface's retry. `{#key}` reads it, so a new attempt
  // rebuilds the await block and calls the route's loader again — a failed
  // chunk fetch is recoverable in place rather than only by reloading the app.
  let routeLoadAttempt = $state(0);
</script>

{#snippet surface()}
  {#if ref?.name === "draft"}
    <SessionDraftPane
      params={ref.params}
      paneId={pane.id}
      {surfaceVisible}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    />
  {:else if ref?.name === "prs"}
    <PrsPage paneId={pane.id} />
  {:else if ref && descriptor?.component}
    {#key routeLoadAttempt}
    {#await descriptor.component()}
      {#if ref.name === "settings"}
        <SettingsPageSkeleton />
      {:else if ref.name === "prReview"}
        <PrReviewSkeleton />
      {:else if ref.name === "tasks"}
        <TasksPageSkeleton />
      {:else if ref.name === "task"}
        <TaskPageSkeleton />
      {:else if ref.name === "automations"}
        <AutomationsPageSkeleton />
      {:else if ref.name === "automation"}
        <AutomationBuilderSkeleton />
      {:else if ref.name === "insights"}
        <InsightsPageSkeleton />
      {:else if ref.name === "folio"}
        <ListPageSkeleton label="Loading workspace" hasPrimaryAction />
      {:else if ref.name === "reviewMode"}
        <PrReviewSkeleton />
      {:else if ref.name === "plan"}
        <PlanModalSkeleton inline />
      {:else if ref.name === "work"}
        {@const work = session.worksStore.get(ref.params.workId)}
        {#if work?.type === "diagram"}
          <DiagramShellSkeleton />
        {:else}
          <DocumentModalSkeleton
            inline
            title={work?.title}
            workStorage={work?.storage}
          />
        {/if}
      {:else if ref.name === "review"}
        <div class="relative h-full min-h-0 w-full">
          <ReviewLoadingSurface view={ref.params.view ?? "diff"} />
          <PaneChrome
            onClose={actions.closeOverlay}
            onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
            isLeading={actions.isLeading}
            closeLabel="Close loading review"
          />
        </div>
      {:else if ref.name === "prDiff"}
        <div class="relative h-full min-h-0 w-full">
          <ReviewLoadingSurface view="diff" />
          <PaneChrome
            onClose={actions.close}
            onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
            isLeading={actions.isLeading}
            closeLabel="Close loading diff"
          />
        </div>
      {:else if ref.name === "files" || ref.name === "fileEditor"}
        <div class="relative h-full min-h-0 w-full">
          <FilesRouteSkeleton variant={ref.name === "files" ? "tree" : "editor"} />
          <PaneChrome
            onClose={actions.closeOverlay}
            onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
            isLeading={actions.isLeading}
            closeLabel={ref.name === "files" ? "Close loading files" : "Close loading file"}
          />
        </div>
      {:else if ref.name === "subagent"}
        <div class="relative h-full min-h-0 w-full">
          <ConversationPaneSkeleton />
          {#if descriptor.placement === "overlay"}
            <PaneChrome
              onClose={actions.closeOverlay}
              onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
              isLeading={actions.isLeading}
              closeLabel="Close loading conversation"
            />
          {/if}
        </div>
      {:else if ref.name === "chat"}
        <ConversationPaneSkeleton />
      {:else}
        <div class="relative h-full min-h-0 w-full">
          <ConversationPaneSkeleton />
          {#if descriptor.placement === "overlay"}
            <!-- After the chrome row: drag rects are collected in DOM order, so
                 the cluster's no-drag holes must come after the row's drag rect. -->
            <PaneChrome
              onClose={actions.closeOverlay}
              onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
              isLeading={actions.isLeading}
              closeLabel="Close loading pane"
            />
          {/if}
        </div>
      {/if}
    {:then routeModule}
      {@const Surface = routeModule.default}
      <Surface
        params={ref.params}
        paneId={pane.id}
        {surfaceVisible}
        {onAttachFile}
        {onScreenshot}
        {onDesignMode}
      />
    {:catch error}
      <!-- Without this branch the pending skeleton above never leaves the
           screen, so a failed chunk fetch reads as a page that is still
           loading. -->
      <RouteLoadError {error} onRetry={() => (routeLoadAttempt += 1)} />
    {/await}
    {/key}
  {/if}
{/snippet}

{#if isPage}
  <!-- Page routes share one macOS safe-area boundary here rather than each
       surface remembering to clear the overlaid window controls. The inset is
       published only when this pane actually reaches the window's top-left. -->
  <div
    class="page-surface flex min-h-0 flex-col {isLeading ? 'flex-1' : 'h-full'}"
    class:page-surface--inset={needsPageTopInset}
  >
    {@render surface()}
  </div>
{:else}
  {@render surface()}
{/if}

<style>
  .page-surface--inset {
    padding-top: var(--solus-page-top-inset, 0px);
  }
</style>
