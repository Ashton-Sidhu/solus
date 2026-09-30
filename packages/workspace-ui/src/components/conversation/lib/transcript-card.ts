/**
 * True when a click landed on a control inside a card or row (a button, link,
 * or field) rather than on the card itself. The card must not open as well.
 */
export function isNestedInteractive(
  target: EventTarget | null,
  root: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(
    "a, button, input, textarea, select, [role='button']",
  );
  return !!interactive && interactive !== root;
}
