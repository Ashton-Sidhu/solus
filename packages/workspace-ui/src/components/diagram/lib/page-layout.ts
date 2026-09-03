import { reapplyLayout, type LayoutSpacing, type NodeSize } from "@solus/contracts/diagram-layout";
import { parseDiagram, serializeDiagram } from "@solus/contracts/diagram-types";

/**
 * Gaps for a drawing that will be read on a page. The canvas keeps nodes far
 * apart so a reader can pan between them; a page has no pan, so air between
 * cards is room the cards could have had. Safe only against measured sizes —
 * the size estimate can be ~90px narrow, which at these gaps would overlap
 * two cards. Ranks still clear their edge labels, which dagre reserves
 * separately from this gap.
 */
export const PRINT_LAYOUT_SPACING: LayoutSpacing = { nodesep: 40, ranksep: 64 };

/**
 * The ways a diagram can be re-drawn for a page: packed with print spacing,
 * top-to-bottom and left-to-right, both laid out from the sizes the canvas
 * measured. The publisher draws whichever of them the page shows largest.
 */
export function printLayoutCandidates(content: string, measured: ReadonlyMap<string, NodeSize>): string[] {
  try {
    const doc = parseDiagram(content);
    return (["TB", "LR"] as const).map((direction) =>
      serializeDiagram(reapplyLayout(doc, direction, { spacing: PRINT_LAYOUT_SPACING, measured })),
    );
  } catch {
    // Unreadable content is the preview's problem to report, not this one's.
    return [];
  }
}
