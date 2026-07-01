import type { Edge, Node } from "@xyflow/svelte";

let diagramClipboard: { nodes: Node[]; edges: Edge[] } | null = null;

export function setDiagramClipboard(nodes: Node[], edges: Edge[]) {
  diagramClipboard = { nodes, edges };
}

export function hasDiagramClipboard(): boolean {
  return !!diagramClipboard?.nodes.length;
}

export function buildClipboardPaste(
  nodeHandlers: Record<string, unknown>,
  edgeHandlers: Record<string, unknown>,
  stamp = Date.now(),
): { nodes: Node[]; edges: Edge[] } | null {
  if (!diagramClipboard?.nodes.length) return null;

  const idMap = new Map<string, string>();
  diagramClipboard.nodes.forEach((n, i) => {
    idMap.set(n.id, `node-${stamp}-${i}`);
  });

  const nodes: Node[] = diagramClipboard.nodes.map((n) => {
    const newId = idMap.get(n.id)!;
    const parentCopied = !!(n.parentId && idMap.has(n.parentId));
    const newParentId = parentCopied
      ? idMap.get(n.parentId!)
      : ((n.parentId ?? undefined) as string | undefined);
    const position = parentCopied
      ? n.position
      : { x: (n.position?.x ?? 0) + 24, y: (n.position?.y ?? 0) + 24 };

    return {
      ...n,
      id: newId,
      selected: true,
      position,
      ...(newParentId ? { parentId: newParentId } : {}),
      data: {
        ...n.data,
        id: newId,
        parentId: newParentId,
        ...nodeHandlers,
      },
    };
  });

  const edges: Edge[] = diagramClipboard.edges.map((e, i) => ({
    ...e,
    id: `e-${stamp}-${i}`,
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
    selected: false,
    data: {
      ...e.data,
      ...edgeHandlers,
    },
  }));

  return { nodes, edges };
}
