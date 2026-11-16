// Adapted from T3 Code native/sheet-surface.ts (MIT, see UPSTREAM.md).
/** iOS sheets can expand to the full window; Android keeps its supplied limit. */
export function formSheetDetents(
  platform: string,
  initialDetent: number,
  androidExpandedDetent = 0.92,
): number[] {
  return [initialDetent, platform === "ios" ? 1 : androidExpandedDetent];
}
