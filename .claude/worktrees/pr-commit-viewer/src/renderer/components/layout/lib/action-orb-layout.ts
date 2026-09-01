// The row is centered, so its maximum width must reserve the orb's right-side
// footprint on both sides: 16px inset + 44px trigger + 8px breathing room.
const ACTION_ORB_CLEARANCE = 68 * 2;

export function actionOrbWouldOverflow(
  availableWidth: number,
  expandedRowWidth: number | null,
  leftReservedWidth = 0,
): boolean {
  const centeredRowWidth = Math.max(
    0,
    availableWidth - Math.max(ACTION_ORB_CLEARANCE, leftReservedWidth * 2),
  );
  return (
    expandedRowWidth !== null &&
    expandedRowWidth > centeredRowWidth
  );
}
