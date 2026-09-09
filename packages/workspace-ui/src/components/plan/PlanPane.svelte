<script lang="ts">
  import RouteLoadError from "../ui/RouteLoadError.svelte";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  // Eager, unlike the modal it covers: the skeleton is what stands in for an
  // async boundary, so it cannot sit behind one itself.
  import PlanModalSkeleton from "./PlanModalSkeleton.svelte";

  let { params, paneId }: RouteSurfaceProps<"plan"> = $props();

  let loadAttempt = $state(0);
  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const pane = paneActions(() => paneId);

  const activePlan = $derived.by(() => {
    const plan = params.planId ? planStore.get(params.planId) : planStore.previewPlan;
    if (!plan?.content.trim()) return null;
    return plan;
  });

  /** A previewed plan (gallery peek) has no pane of its own to fall back to —
   *  closing it in the leading pane dismisses the whole preview, while in a
   *  companion pane it drops the preview and closes just that pane. */
  function close() {
    if (planStore.previewDescriptor) {
      if (pane.isLeading) {
        session.closePlanPreview();
        return;
      }
      planStore.dismissPreview();
    }
    pane.close();
  }
</script>

<!-- The pane opens on the plan id before its body is off disk, so "no plan yet"
     is the loading state, not an empty pane. The open path retracts the pane if
     the read comes back with nothing. -->
{#if activePlan}
  {#key loadAttempt}
    {#await import("./PlanModal.svelte")}
    <PlanModalSkeleton inline />
  {:then planModule}
    {@const PlanModal = planModule.default}
    <PlanModal plan={activePlan} inline minimizeOutline={!pane.isLeading} onClose={close} />
  {:catch error}
      <RouteLoadError {error} compact onRetry={() => (loadAttempt += 1)} />
    {/await}
    {/key}
{:else}
  <PlanModalSkeleton inline />
{/if}
<!-- After the content: the skeleton header is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={close}
  onOpenInSplit={pane.moveAcross}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close plan"
  closeTestId="plan-modal-close"
/>
