/** A field that takes typed text, where Enter and Escape belong to the field. */
export function isTypingTarget(target: Pick<HTMLElement, 'tagName' | 'isContentEditable'>): boolean {
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
}
