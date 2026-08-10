<script lang="ts">
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import ReviewGuidePane from "./ReviewGuidePane.svelte";
  import { untrack } from "svelte";

  let { params, paneId }: RouteSurfaceProps<"review"> = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const pane = paneActions(paneId);
  const reviewSourceTabId = untrack(() => params.sourceTabId ?? session.activeTabId);

  // Legacy/deep-linked routes may not name their source. Capture the tab that
  // owns the restored review once and persist it, so later tab changes cannot
  // move the guide's RPCs to another host.
  $effect(() => {
    if (params.sourceTabId || !reviewSourceTabId) return;
    session.router.navigate(
      {
        name: "review",
        params: { ...params, sourceTabId: reviewSourceTabId },
      },
      { target: paneId, replace: true },
    );
  });

  // The origin checkout is derived rather than carried in the route: the guide
  // regenerates against whatever the source session is on *now*, and keeping a
  // GitCheckout out of the params is what lets a review be linked to.
  const environment = $derived(
    environmentStore.environmentFor(
      reviewSourceTabId ? session.sessionFor(reviewSourceTabId)?.run : undefined,
    ),
  );
</script>

<ReviewGuidePane
  guideKey={params.key}
  scope={params.scope}
  sourceTabId={reviewSourceTabId}
  workingDirectory={environment.cwd}
  gitContext={environment.checkout}
  isLeading={pane.isLeading}
  onOpenInSplit={pane.moveAcross}
  onClose={pane.close}
/>
