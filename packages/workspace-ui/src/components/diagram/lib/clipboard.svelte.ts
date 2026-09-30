import type { DiagramEdge, DiagramNode } from "@solus/contracts/diagram-types";

// Copied content, not canvas nodes: a paste keeps every field of the original.
let diagramClipboard: { nodes: readonly DiagramNode[]; edges: readonly DiagramEdge[] } | null = null;

export function setDiagramClipboard(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]) {
  diagramClipboard = { nodes, edges };
}

export function hasDiagramClipboard(): boolean {
  return !!diagramClipboard?.nodes.length;
}

/** Fresh copies of the clipboard with new ids, offset unless their parent came along. */
export function buildClipboardPaste(
  stamp = Date.now(),
): { nodes: DiagramNode[]; edges: DiagramEdge[] } | null {
  if (!diagramClipboard?.nodes.length) return null;

  const idMap = new Map<string, string>();
  diagramClipboard.nodes.forEach((n, i) => {
    idMap.set(n.id, `node-${stamp}-${i}`);
  });

  const nodes: DiagramNode[] = diagramClipboard.nodes.map((n) => {
    const parentCopied = !!(n.parentId && idMap.has(n.parentId));
    const copied: DiagramNode = {
      ...structuredClone(n),
      id: idMap.get(n.id)!,
      position: parentCopied
        ? n.position
        : { x: (n.position?.x ?? 0) + 24, y: (n.position?.y ?? 0) + 24 },
    };
    if (n.parentId) copied.parentId = idMap.get(n.parentId) ?? n.parentId;
    return copied;
  });

  const edges: DiagramEdge[] = diagramClipboard.edges.map((e, i) => ({
    ...structuredClone(e),
    id: `e-${stamp}-${i}`,
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
  }));

  return { nodes, edges };
}
