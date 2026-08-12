import { MarkerType, type Edge, type Node } from "@xyflow/svelte";
import type { DiagramEdge, DiagramNode } from "../../../../shared/diagram-types";
import {
  COLLAPSED_H,
  GROUP_H,
  GROUP_W,
  orderParentsFirst,
} from "./graph-layout";

/**
 * Arrowheads sit a step darker than the line (whose default stroke comes from
 * `.svelte-flow__edge-path` in DiagramShell.css) so they read as punctuation.
 */
export const DEFAULT_ARROW_COLOR = "var(--diagram-edge-arrow)";

export function toFlowNodes<TNodeHandlers extends object>(
  diagNodes: DiagramNode[],
  expandedNodeIds: Set<string>,
  nodeHandlers: TNodeHandlers,
): Node[] {
  const byId = new Map(diagNodes.map((n) => [n.id, n]));
  const hiddenByCollapse = (n: DiagramNode): boolean => {
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    while (p) {
      if (p.group && p.collapsed) return true;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return false;
  };

  return orderParentsFirst(
    diagNodes.map((n) => {
      const width = n.width ?? (n.group ? GROUP_W : undefined);
      const dataHeight = n.height ?? (n.group ? GROUP_H : undefined);
      const collapsedGroup = !!n.group && !!n.collapsed;
      const height = collapsedGroup ? COLLAPSED_H : dataHeight;
      return {
        id: n.id,
        type: n.group ? "group" : "default",
        position: n.position ?? { x: 0, y: 0 },
        hidden: hiddenByCollapse(n),
        ...(n.parentId ? { parentId: n.parentId } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        style:
          [
            width ? `width:${width}px` : "",
            height ? `height:${height}px` : "",
          ]
            .filter(Boolean)
            .join(";") || undefined,
        data: {
          ...n,
          detail: n.detail,
          expanded: expandedNodeIds.has(n.id),
          dimmed: false,
          ...nodeHandlers,
        },
      };
    }),
  );
}

export function toFlowEdges<TEdgeHandlers extends object>(
  diagEdges: DiagramEdge[],
  edgeHandlers: TEdgeHandlers,
): Edge[] {
  return diagEdges.map((e) => {
    const isAsync = e.kind === "async";
    const isData = e.kind === "data";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      label: e.label,
      type: "default",
      animated: e.animated ?? false,
      className: isAsync ? "edge--async" : isData ? "edge--data" : undefined,
      ...edgeRenderProps(e.color, e.width, e.cardinality ? 'none' : e.arrows, e.dash),
      data: {
        kind: e.kind,
        animated: e.animated,
        body: e.body,
        color: e.color,
        width: e.width,
        dash: e.dash,
        arrows: e.arrows,
        shape: e.shape,
        bendOffset: e.bendOffset,
        cardinality: e.cardinality,
        floatingSource: !e.sourceHandle,
        floatingTarget: !e.targetHandle,
        ...edgeHandlers,
      },
    };
  });
}

/** The dash an edge actually draws with: explicit if set, else kind-derived. */
export function effectiveEdgeDash(
  kind: DiagramEdge["kind"],
  dash: DiagramEdge["dash"],
): NonNullable<DiagramEdge["dash"]> {
  return dash ?? (kind === "async" ? "dashed" : "solid");
}

export function edgeRenderProps(
  color: string | undefined,
  width: number | undefined,
  arrows: DiagramEdge["arrows"],
  dash: DiagramEdge["dash"],
) {
  const styleParts: string[] = [];
  if (color) styleParts.push(`stroke:${color}`);
  if (width != null) styleParts.push(`stroke-width:${width}px`);
  // Inline style outranks the `.edge--async` class rule, so an explicit value
  // is what makes a solid async (or a dashed sync) edge possible. Unset emits
  // nothing and leaves the kind-derived class in charge. The base path sets no
  // linecap, so dotted must ask for round or the dots render as squares.
  if (dash === "dashed") styleParts.push("stroke-dasharray:5 5");
  else if (dash === "dotted") styleParts.push("stroke-dasharray:0.1 4", "stroke-linecap:round");
  else if (dash === "solid") styleParts.push("stroke-dasharray:none");
  const a = arrows ?? "end";
  // An open chevron, not a filled triangle: on parchment a solid head reads far
  // heavier than the 1.3px line it terminates.
  const head = {
    type: MarkerType.Arrow,
    width: 16,
    height: 16,
    strokeWidth: 1.3,
    color: color ?? DEFAULT_ARROW_COLOR,
  };
  return {
    style: styleParts.length ? styleParts.join(";") : undefined,
    markerStart: a === "start" || a === "both" ? head : undefined,
    markerEnd: a === "end" || a === "both" ? head : undefined,
  };
}
