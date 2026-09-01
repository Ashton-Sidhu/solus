const PANEL_EDGE_GUTTER = 32;

export function actionOrbWouldOverflow(
  availableWidth: number,
  expandedRowWidth: number | null,
  leftReservedWidth = 0,
): boolean {
  const centeredRowWidth = Math.max(
    0,
    availableWidth - Math.max(PANEL_EDGE_GUTTER, leftReservedWidth * 2),
  );
  return (
    expandedRowWidth !== null &&
    expandedRowWidth > centeredRowWidth
  );
}
