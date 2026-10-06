<script module lang="ts">
  import type { Component } from "svelte";

  type RouteModule = { default: Component<any> };

  /** Route modules that have loaded once, by route name. Awaiting a loaded
   *  module again still paints the skeleton for a frame before the surface —
   *  a second open of a task flashed its skeleton for no reason. A settled
   *  module is handed to the await block as a value, which renders at once. */
  const loadedRouteModules = new Map<string, RouteModule>();

  function loadRoute(
    name: string,
    load: () => Promise<RouteModule>,
  ): RouteModule | Promise<RouteModule> {
    return (
      loadedRouteModules.get(name) ??
      load().then((module) => {
        loadedRouteModules.set(name, module);
        return module;
      })
    );
  }
</script>

<script lang="ts">
  import type { PaneEntry } from "../../contexts/workspace/routing/location";
  import { ROUTES, type RouteRef } from "../../contexts/workspace/routing/route-registry";
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
  import FilesRouteSkeleton from "../files/FilesRouteSkeleton.svelte";
  // Keep both sides of the draft-to-chat transition in the shell chunk so
  // opening a draft or sending it never flashes a route-loading skeleton.
  import SessionDraftPane from "../session-draft/SessionDraftPane.svelte";
  import ConversationPane from "../conversation/ConversationPane.svelte";
  // Eager too: the pane is light (the document and diagram shells stay lazy
  // inside it) and it owns one loading state — skeleton plus close control —
  // for both the module and the content read, so a work never opens through
  // a second skeleton that cannot be dismissed.
  import WorkPane from "../work/WorkPane.svelte";
  // The PR page's own loading state, drawn while its module loads. Eagerly
  // importing the page itself to avoid a second loading state cost the whole
  // review stack — PrDetailPanel -> PrReviewPane -> DiffPanel + DocumentEditor,
  // about 4 MB of Tiptap, CodeMirror and diff machinery — on every boot. The
  // skeleton is the same silhouette the page draws for its data read, so the
  // module load and the data load read as one state anyway.
  import PrsPageSkeleton from "../prs/PrsPageSkeleton.svelte";
  import ListPageSkeleton from "./list-page/ListPageSkeleton.svelte";
  import RouteLoadError from "./RouteLoadError.svelte";
  import PaneChrome from "./PaneChrome.svelte";
  import { paneActions } from "./lib/pane-actions.svelte";
  import { setUnderStrip } from "./lib/pane-strip";

  /**
   * The route outlet for one route in one pane — the destination, or one
   * surface of the strip: drafts and chats mount directly; other routes load
   * through the registry. Each surface owns its own chrome.
   */
  interface Props extends Omit<PaneSurfaceProps, "paneId"> {
    pane: PaneEntry;
    surface: RouteRef;
  }

  let { pane, surface: ref, surfaceVisible = true, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const actions = paneActions(() => pane.id);
  const descriptor = $derived(ROUTES[ref.name]);
  // Pages used to size themselves with `flex-1` as children of the content
  // column; a companion pane's wrapper is a block, so it needs the height.
  const isPage = $derived(descriptor.ownsTitlebarChrome === true);
  const isLeading = $derived(session.router.leadingPane.id === pane.id);
  // Every pane beside the leading one is a companion pane, and it always draws
  // its strip.
  setUnderStrip(() => !isLeading);
  // Bumped by the error surface's retry. `{#key}` reads it, so a new attempt
  // rebuilds the await block and calls the route's loader again — a failed
  // chunk fetch is recoverable in place rather than only by reloading the app.
  let routeLoadAttempt = $state(0);
</script>

{#snippet surface()}
  {#if ref.name === "draft"}
    <SessionDraftPane
      params={ref.params}
      paneId={pane.id}
      {surfaceVisible}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    />
  {:else if ref.name === "chat"}
    <ConversationPane
      params={ref.params}
      paneId={pane.id}
      {surfaceVisible}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    />
  {:else if ref.name === "work"}
    <WorkPane
      params={ref.params}
      paneId={pane.id}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    />
  {:else if descriptor.component}
    <!-- An await block can keep its previous component until the next loader
         settles. Drop it before a different route supplies incompatible params.
         Keep same-route updates mounted so they retain their local state. -->
    {#key `${ref.name}:${routeLoadAttempt}`}
    {#await loadRoute(ref.name, descriptor.component)}
      {#if ref.name === "settings"}
        <SettingsPageSkeleton />
      {:else if ref.name === "prReview"}
        <PrReviewSkeleton embedded={!isLeading} />
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
      {:else if ref.name === "prs"}
        <PrsPageSkeleton />
      {:else if ref.name === "folio"}
        <ListPageSkeleton label="Loading workspace" hasPrimaryAction />
      {:else if ref.name === "reviewMode"}
        <PrReviewSkeleton />
      {:else if ref.name === "plan"}
        <PlanModalSkeleton inline />
      {:else if ref.name === "review"}
        <div class="relative h-full min-h-0 w-full">
          <ReviewLoadingSurface view={ref.params.view ?? "diff"} />
          <PaneChrome
            onClose={actions.close}
            closeLabel="Close loading review"
          />
        </div>
      {:else if ref.name === "prDiff"}
        <div class="relative h-full min-h-0 w-full">
          <ReviewLoadingSurface view="diff" />
          <PaneChrome
            onClose={actions.close}
            closeLabel="Close loading diff"
          />
        </div>
      {:else if ref.name === "files"}
        <div class="relative h-full min-h-0 w-full">
          <FilesRouteSkeleton variant={ref.params.path ? "editor" : "tree"} />
          <PaneChrome
            onClose={actions.close}
            closeLabel="Close loading files"
          />
        </div>
      {:else if ref.name === "subagent"}
        <div class="relative h-full min-h-0 w-full">
          <ConversationPaneSkeleton />
          {#if !isLeading}
            <PaneChrome
              onClose={actions.close}
              closeLabel="Close loading conversation"
            />
          {/if}
        </div>
      {:else}
        <div class="relative h-full min-h-0 w-full">
          <ConversationPaneSkeleton />
          {#if !isLeading}
            <!-- After the chrome row: drag rects are collected in DOM order, so
                 the cluster's no-drag holes must come after the row's drag rect. -->
            <PaneChrome
              onClose={actions.close}
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
  <div class="page-surface flex min-h-0 flex-col {isLeading ? 'flex-1' : 'h-full'}">
    {@render surface()}
  </div>
{:else}
  {@render surface()}
{/if}
