import type { DiagramNode, DiagramNodeSilhouette } from '../../../shared/diagram-types'
import { DIAGRAM_NODE_SILHOUETTES } from '../../../shared/diagram-types'

export const DIAGRAM_NODE_SILHOUETTE_OPTIONS: {
  value: DiagramNodeSilhouette
  label: string
  decorative: boolean
}[] = DIAGRAM_NODE_SILHOUETTES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
  decorative: value === 'circle' || value === 'diamond',
}))

const DECORATIVE_NODE_SILHOUETTES = new Set<DiagramNodeSilhouette>(
  DIAGRAM_NODE_SILHOUETTE_OPTIONS.filter((option) => option.decorative).map((option) => option.value),
)

export function isDecorativeNodeSilhouette(silhouette: DiagramNode['silhouette']): boolean {
  return !!silhouette && DECORATIVE_NODE_SILHOUETTES.has(silhouette)
}

export function isSimpleDiagramNode(
  node: Pick<DiagramNode, 'badges' | 'body' | 'fields' | 'html' | 'meta' | 'metrics' | 'subtitle' | 'tags'>,
): boolean {
  return !(
    node.subtitle ||
    node.body ||
    node.html ||
    node.badges?.length ||
    node.fields?.length ||
    node.tags?.length ||
    node.meta ||
    node.metrics
  )
}
