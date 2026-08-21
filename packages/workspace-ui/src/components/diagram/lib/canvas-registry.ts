import type { EdgeTypes, NodeTypes } from '@xyflow/svelte'
import DiagramNodeComponent from '../nodes/DiagramNode.svelte'
import DiagramGroupNode from '../nodes/DiagramGroupNode.svelte'
import DiagramEdgeComponent from '../edges/DiagramEdge.svelte'

// The one place a canvas learns what a node and an edge look like. Both the
// editing shell and the read-only preview register these, so a new node type
// cannot reach one surface and silently render as an xyflow default box on the
// other. Kept out of `flow-builders` on purpose: the thumbnail imports that
// module for one dash helper and must not pull the card components with it.
export const DIAGRAM_NODE_TYPES: NodeTypes = {
  default: DiagramNodeComponent,
  group: DiagramGroupNode,
}

export const DIAGRAM_EDGE_TYPES: EdgeTypes = {
  default: DiagramEdgeComponent,
}
