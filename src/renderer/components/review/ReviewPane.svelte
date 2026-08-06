<script lang="ts">
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import ReviewGuidePane from "./ReviewGuidePane.svelte";

  let { params, paneId }: RouteSurfaceProps<"review"> = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const pane = paneActions(paneId);

  // The origin checkout is derived rather than carried in the route: the guide
  // regenerates against whatever the source session is on *now*, and keeping a
  // GitCheckout out of the params is what lets a review be linked to.
  const environment = $derived(environmentStore.environmentFor(params.sourceTabId ? session.sessionFor(params.sourceTabId)?.run : undefined));
</script>

<ReviewGuidePane
  guideKey={params.key}
  scope={params.scope}
  sourceTabId={params.sourceTabId}
  workingDirectory={environment.cwd}
  gitContext={environment.checkout}
  isLeading={pane.isLeading}
  onOpenInSplit={pane.moveAcross}
  onClose={pane.close}
/>
