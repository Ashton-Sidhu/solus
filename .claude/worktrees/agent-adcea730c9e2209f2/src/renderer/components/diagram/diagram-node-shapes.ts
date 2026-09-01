import type { DiagramNode, DiagramNodeShape } from '../../../shared/diagram-types'
import { DIAGRAM_NODE_SHAPES } from '../../../shared/diagram-types'

export const DIAGRAM_NODE_SHAPE_OPTIONS: {
  value: DiagramNodeShape
  label: string
  decorative: boolean
}[] = DIAGRAM_NODE_SHAPES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
  decorative: value === 'circle' || value === 'diamond',
}))

const DECORATIVE_NODE_SHAPES = new Set<DiagramNodeShape>(
  DIAGRAM_NODE_SHAPE_OPTIONS.filter((shape) => shape.decorative).map((shape) => shape.value),
)

export function isDecorativeNodeShape(shape: DiagramNode['shape']): boolean {
  return !!shape && DECORATIVE_NODE_SHAPES.has(shape)
}

export function isSimpleShapeNode(
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
