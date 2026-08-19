<script lang="ts">
  import { untrack } from "svelte";
  import type { PaneEntry } from "../../contexts/workspace/routing/location";
  import { visibleRef } from "../../contexts/workspace/routing/location";
  import { ROUTES } from "../../contexts/workspace/routing/route-registry";
  import type { PaneSurfaceProps } from "./lib/pane-surface";
  import { getWorkspaceContext } from "../../contexts";
  // Eager, unlike every surface below: these are what cover an async boundary,
  // so they cannot sit behind one themselves.
  import ConversationPaneSkeleton from "../conversation/ConversationPaneSkeleton.svelte";
  import SettingsPageSkeleton from "../settings/SettingsPageSkeleton.svelte";
  import PrsPageSkeleton from "../prs/PrsPageSkeleton.svelte";
  import PrReviewSkeleton from "../pr-review/PrReviewSkeleton.svelte";
  import TasksPageSkeleton from "../tasks/TasksPageSkeleton.svelte";
  import TaskPageSkeleton from "../tasks/task-page/TaskPageSkeleton.svelte";
  import AutomationsPageSkeleton from "../automations/AutomationsPageSkeleton.svelte";
  import AutomationBuilderSkeleton from "../automations/AutomationBuilderSkeleton.svelte";
  import InsightsPageSkeleton from "../insights/InsightsPageSkeleton.svelte";
  import ReviewLoadingSurface from "../review/ReviewLoadingSurface.svelte";
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
  const actions = paneActions(untrack(() => pane.id));
  const ref = $derived(visibleRef(pane));
  const descriptor = $derived(ref ? ROUTES[ref.name] : null);
  // Pages used to size themselves with `flex-1` as children of the content
  // column; a companion pane's wrapper is a block, so it needs the height.
  const isPage = $derived(descriptor?.exclusiveGroup === "page");
  const needsPageTopInset = $derived(
    isPage && descriptor?.ownsTitlebarChrome !== true,
  );
  const isLeading = $derived(session.router.leadingPane.id === pane.id);
</script>

{#snippet surface()}
  {#if ref && descriptor?.component}
    {#await descriptor.component()}
      {#if ref.name === "settings"}
        <SettingsPageSkeleton />
      {:else if ref.name === "prs"}
        <PrsPageSkeleton />
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
      {:else if ref.name === "chat"}
        <ConversationPaneSkeleton />
      {:else}
        <div class="flex h-full min-h-32 w-full flex-col">
          <div
            class="workspace-titlebar h-(--solus-chrome-row-h) shrink-0"
            aria-hidden="true"
          ></div>
          <div
            class="grid min-h-0 flex-1 place-items-center text-xs text-(--solus-text-tertiary)"
            role="status"
          >
            Loading…
          </div>
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
    {/await}
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
