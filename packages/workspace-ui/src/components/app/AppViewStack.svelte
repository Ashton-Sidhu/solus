<script lang="ts">
  import type { Snippet } from "svelte";
  import type { AppSurfaceView } from "./lib/app-view";

  /**
   * The two views of the app surface (docs/plans/apps.md §9.1). The app's own
   * view stays mounted while the Manage page shows: it is hidden, not removed,
   * so the frame keeps its page and the UI keeps its state.
   */
  interface Props {
    view: AppSurfaceView;
    appContent: Snippet;
    manageContent: Snippet;
  }
  let { view, appContent, manageContent }: Props = $props();
</script>

<div class="h-full min-h-0" hidden={view === "manage"} data-testid="app-view-app">
  {@render appContent()}
</div>
{#if view === "manage"}
  <div class="h-full min-h-0" data-testid="app-view-manage">
    {@render manageContent()}
  </div>
{/if}
