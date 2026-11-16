<script lang="ts">
  import type { AppCaller } from "@solus/contracts/apps";
  import FlowCanvas from "./FlowCanvas.svelte";
  import RunFlowNode from "./RunFlowNode.svelte";
  import { setRunFlowView } from "./lib/flow-views";
  import { runFlow } from "./lib/run-flow";
  import type { RunGraph } from "./lib/run-graph";

  /**
   * The graph of one run in the section's one card (docs/plans/apps.md
   * §9.2): the trigger on top and each layer of steps under it, joined by
   * curves. The nodes are built again only when the graph changes; the clock
   * and the selection reach them through the view.
   */
  interface Props {
    /** The run the graph is of: another run fits the view again. */
    runId: string;
    graph: RunGraph;
    caller: AppCaller;
    /** "github-release": who or what started the run. */
    triggerName: string;
    /** "Webhook · 14:01:41". */
    triggerDetail: string;
    selectedStep: string | null;
    onSelectStep: (name: string) => void;
    now: number;
  }
  let { runId, graph, caller, triggerName, triggerDetail, selectedStep, onSelectStep, now }: Props = $props();

  setRunFlowView({
    get now() {
      return now;
    },
    get selectedStep() {
      return selectedStep;
    },
    selectStep: (name) => onSelectStep(name),
  });

  const flow = $derived(runFlow(graph, { caller, name: triggerName, detail: triggerDetail }));
  const nodeTypes = { trigger: RunFlowNode, step: RunFlowNode };
</script>

<!-- A step that starts adds a node: the view fits it in. -->
<FlowCanvas
  nodes={flow.nodes}
  edges={flow.edges}
  {nodeTypes}
  label="The steps of the run"
  fitKey="{runId}:{flow.nodes.length}"
  class="h-[470px] flex-1 @max-[48rem]/pane:h-[400px]"
  testId="app-run-graph"
/>
