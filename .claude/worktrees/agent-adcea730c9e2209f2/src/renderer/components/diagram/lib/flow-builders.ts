import { MarkerType, type Edge, type Node } from "@xyflow/svelte";
import type { DiagramEdge, DiagramNode } from "../../../../shared/diagram-types";
import {
  COLLAPSED_H,
  GROUP_H,
  GROUP_W,
  orderParentsFirst,
} from "./graph-layout";

export const DEFAULT_EDGE_COLOR = "var(--solus-text-tertiary)";

export function toFlowNodes(
  diagNodes: DiagramNode[],
  expandedNodeIds: Set<string>,
  nodeHandlers: Record<string, unknown>,
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

export function toFlowEdges(
  diagEdges: DiagramEdge[],
  edgeHandlers: Record<string, unknown>,
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
      ...edgeRenderProps(e.color, e.width, e.cardinality ? 'none' : e.arrows),
      data: {
        kind: e.kind,
        animated: e.animated,
        color: e.color,
        width: e.width,
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

export function edgeRenderProps(
  color: string | undefined,
  width: number | undefined,
  arrows: DiagramEdge["arrows"],
) {
  const styleParts: string[] = [];
  if (color) styleParts.push(`stroke:${color}`);
  if (width != null) styleParts.push(`stroke-width:${width}px`);
  const a = arrows ?? "end";
  const head = {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
    color: color ?? DEFAULT_EDGE_COLOR,
  };
  return {
    style: styleParts.length ? styleParts.join(";") : undefined,
    markerStart: a === "start" || a === "both" ? head : undefined,
    markerEnd: a === "end" || a === "both" ? head : undefined,
  };
}
