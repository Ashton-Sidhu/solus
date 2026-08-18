<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import type {
    ReviewView,
    RouteParams,
  } from "../../contexts/workspace/routing/route-registry";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import ReviewSurface from "./ReviewSurface.svelte";

  // The review pane as a route: the location owns which change is being read
  // and which view is showing, so a review is linkable and comes back on the
  // view its reader left it on. Everything else is the surface's.
  let { params, paneId }: RouteSurfaceProps<"review"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);

  const view = $derived<ReviewView>(params.view ?? "diff");

  function selectView(next: ReviewView) {
    const nextParams: RouteParams["review"] = { ...params, view: next };
    session.router.navigate(
      { name: "review", params: nextParams },
      { target: paneId, replace: true },
    );
  }

  // Jumping to a file is a request, not a state: asking for the same file twice
  // has to move the panel again. The router's navigation epoch is that request.
  const navigationRequestId = $derived(
    params.filePath ? session.router.navigationEpoch : undefined,
  );
</script>

<ReviewSurface
  sourceTabId={params.sourceTabId}
  {view}
  onSelectView={selectView}
  scope={params.scope}
  filePath={params.filePath}
  {navigationRequestId}
  initialSkeletonVisible
  onClose={pane.closeOverlay}
/>

<!-- After the content: the toolbar above is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.closeOverlay}
  onOpenInSplit={!pane.isLeading ? pane.moveAcross : undefined}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close review"
/>
