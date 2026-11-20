// Adapted from T3 Code ComposerSurface.tsx and compactEditorInsets.ts (MIT; see UPSTREAM.md).
export const COMPOSER_TRANSITION_DURATION_MS = 220;
export const ONE_ROW_MIN_EDITOR_SHARE = "40%";

/** A wider expanded editor must still fit its compact slot before collapsing. */
export function nativeComposerOverflowsRow(
  size: { readonly width: number; readonly height: number },
  compactWidth: number,
  lineHeight: number,
): boolean {
  return (
    size.height > lineHeight * 1.5 ||
    (compactWidth > 0 && size.width > compactWidth)
  );
}

/** T3's lowercase-midline correction keeps scaled text aligned with the row. */
export function oneRowEditorInset(
  text: { readonly fontSize: number; readonly lineHeight: number },
  platform: "ios" | "android",
): number {
  if (platform === "android") return 6;
  const midlineShift =
    text.lineHeight - 0.562 * text.fontSize - (23 - 0.562 * 16);
  return Math.max(0, Math.round(6 - midlineShift));
}

/** The editor has a 36-point minimum inside the row's 44-point controls. */
export function oneRowEditorHeight(lineHeight: number, inset = 6): number {
  return Math.max(36, Math.ceil(lineHeight) + 2 * inset);
}

/** Yoga measures x from the left; React Native swaps insets in RTL layouts. */
export function compactEditorInsets(input: {
  readonly slotX: number;
  readonly slotWidth: number;
  readonly rowWidth: number;
  readonly isRTL: boolean;
}): { left: number; right: number } {
  "worklet";
  const fromLeft = input.slotX + 4;
  const fromRight = input.rowWidth - input.slotX - input.slotWidth + 4;
  return input.isRTL
    ? { left: fromRight, right: fromLeft }
    : { left: fromLeft, right: fromRight };
}
