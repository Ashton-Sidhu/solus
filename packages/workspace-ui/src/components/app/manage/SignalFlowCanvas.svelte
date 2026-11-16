<script lang="ts">
  import type { AppSignalActionView, AppSignalView } from "@solus/contracts/apps";
  import FlowCanvas from "./FlowCanvas.svelte";
  import SignalFlowNode from "./SignalFlowNode.svelte";
  import { isCompactPane } from "../../../lib/pane-width";
  import { setSignalFlowView } from "./lib/flow-views";
  import { signalFlow } from "./lib/signal-flow";

  /**
   * The flow of one signal in the section's one card (docs/plans/apps.md
   * §9.2), left to right: what emitted it, the signal, and its actions with
   * the node that adds one. A narrow pane stacks the nodes top to bottom, at
   * the same 48rem as the section's other columns.
   */
  interface Props {
    signal: AppSignalView;
    isBusy: boolean;
    editingActionId: string | null;
    summaryOf: (action: AppSignalActionView) => string;
    onEdit: (action: AppSignalActionView | null) => void;
    onSetEnabled: (action: AppSignalActionView, enabled: boolean) => void;
  }
  let { signal, isBusy, editingActionId, summaryOf, onEdit, onSetEnabled }: Props = $props();

  let width = $state(0);
  const isStacked = $derived(isCompactPane(width));

  setSignalFlowView({
    get isStacked() {
      return isStacked;
    },
    get isBusy() {
      return isBusy;
    },
    get editingActionId() {
      return editingActionId;
    },
    summaryOf: (action) => summaryOf(action),
    edit: (action) => onEdit(action),
    setEnabled: (action, enabled) => onSetEnabled(action, enabled),
  });

  const flow = $derived(signalFlow(signal, isStacked));
  const nodeTypes = { emitter: SignalFlowNode, signal: SignalFlowNode, action: SignalFlowNode, add: SignalFlowNode };
</script>

<div class="min-w-0" bind:clientWidth={width}>
  <FlowCanvas
    nodes={flow.nodes}
    edges={flow.edges}
    {nodeTypes}
    label="The flow of {signal.name}"
    fitKey="{signal.name}:{isStacked}:{flow.nodes.length}"
    class={isStacked ? "h-[460px]" : "h-75"}
    testId="app-signal-flow"
  />
</div>
