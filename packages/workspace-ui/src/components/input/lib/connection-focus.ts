/** A completed connection may restore typing only while this composer owns focus. */
export function shouldFocusReadyComposer(
  ownsFocusedPane: boolean,
  activeElement: Pick<HTMLElement, 'tagName' | 'isContentEditable'> | null,
): boolean {
  if (!ownsFocusedPane) return false
  return activeElement?.tagName !== 'INPUT'
    && activeElement?.tagName !== 'TEXTAREA'
    && !activeElement?.isContentEditable
}
