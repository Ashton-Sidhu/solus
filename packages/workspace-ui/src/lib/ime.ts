// A key that belongs to an IME composition (Japanese, Chinese, Korean input).
// Safari reports the key that ends a composition with `isComposing` false but
// `keyCode` 229, so both signals are needed.
export function isImeKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}
