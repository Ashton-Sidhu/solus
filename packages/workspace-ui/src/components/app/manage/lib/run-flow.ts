import type { Edge, Node } from '@xyflow/svelte'
import type { AppCaller, AppStepState } from '@solus/contracts/apps'
import { flowEdge } from './flow'
import type { GraphStep, RunGraph } from './run-graph'

/**
 * The run graph of the Workflows section as Svelte Flow nodes and edges
 * (docs/plans/apps.md §9.2): the trigger on top, then each layer of steps in
 * a row under it, top to bottom. A step node joins every node of the next
 * row. The layout is a pure function of the graph, so the same run always
 * draws the same way.
 */

export const RUN_NODE_WIDTH = 210
export const RUN_NODE_HEIGHT = 52
const ROW_GAP = 40
const COLUMN_GAP = 30

/** The trigger node: who or what started the run. */
export type RunTriggerNodeData = {
  kind: 'trigger'
  caller: AppCaller
  /** "github-release". */
  name: string
  /** "Webhook · 14:01:41". */
  detail: string
}

/** A step node. `not-run` is a step the newest good run did and this run did not reach: it is dashed. */
export type RunStepNodeData = {
  kind: 'step'
  entry: GraphStep
  state: AppStepState | 'not-run'
}

export type RunFlowNode = Node<RunTriggerNodeData, 'trigger'> | Node<RunStepNodeData, 'step'>

export interface RunFlow {
  nodes: RunFlowNode[]
  edges: Edge[]
}

export const RUN_TRIGGER_NODE_ID = 'trigger'

/** The id of a step's node. A step may be named "trigger", so the ids have their own prefix. */
export function runStepNodeId(name: string): string {
  return `step:${name}`
}

/**
 * The nodes and edges of `graph`. A position is the top center of its node
 * (`origin` [0.5, 0]), so each row is centered on x = 0.
 */
export function runFlow(graph: RunGraph, trigger: Omit<RunTriggerNodeData, 'kind'>): RunFlow {
  const origin: [number, number] = [0.5, 0]
  const fixed = { width: RUN_NODE_WIDTH, height: RUN_NODE_HEIGHT, origin, draggable: false, connectable: false, selectable: false, focusable: false }
  const rowY = (row: number) => row * (RUN_NODE_HEIGHT + ROW_GAP)
  const columnX = (index: number, count: number) => (index - (count - 1) / 2) * (RUN_NODE_WIDTH + COLUMN_GAP)

  const nodes: RunFlowNode[] = [{ id: RUN_TRIGGER_NODE_ID, type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'trigger', ...trigger }, ...fixed }]
  const edges: Edge[] = []
  let above = [RUN_TRIGGER_NODE_ID]
  graph.layers.forEach((layer, index) => {
    const row: string[] = []
    layer.forEach((entry, column) => {
      const id = runStepNodeId(entry.name)
      const state = entry.step?.state ?? 'not-run'
      nodes.push({ id, type: 'step', position: { x: columnX(column, layer.length), y: rowY(index + 1) }, data: { kind: 'step', entry, state }, ...fixed })
      for (const source of above) edges.push(flowEdge(source, id, state === 'not-run'))
      row.push(id)
    })
    above = row
  })
  return { nodes, edges }
}
