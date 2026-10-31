/**
 * The empty workspace that the build wrote into the page's HTML
 * (docs/plans/fast-secure-startup.md, step 5; `scripts/vite-workspace-first-screen.ts`).
 * It is plain markup, painted before any code runs. The workspace replaces it in
 * the same task as it mounts, so no frame shows between them, and it takes what
 * the person typed into the frame's prompt field. Every other page (a share
 * link's landing, pairing, the page with no host) removes it before it mounts.
 */

/** What the person did in the frame's prompt field before the workspace came. */
export interface FirstScreenDraft {
  text: string
  hadFocus: boolean
}

/** Removes the frame, and says what was typed into it. Null when the page has no frame (any later mount). */
export function removeFirstScreen(root: HTMLElement): FirstScreenDraft | null {
  const frame = root.querySelector('[data-first-screen]')
  if (!frame) return null
  const field = frame.querySelector('textarea')
  const draft = { text: field?.value ?? '', hadFocus: field !== null && root.ownerDocument.activeElement === field }
  frame.remove()
  return draft
}

/**
 * Gives the frame's draft to the workspace's composer. Its prompt field is the
 * editor's plain stand-in while the editor loads; the `input` event is the one
 * the stand-in reads, so the text reaches the draft by the workspace's own path.
 */
export function restoreFirstScreenDraft(root: HTMLElement, draft: FirstScreenDraft | null): void {
  if (!draft || (!draft.text && !draft.hadFocus)) return
  // The composer on screen: a hidden pane may hold another one.
  const field = [...root.querySelectorAll<HTMLTextAreaElement>('[data-session-drop-area] textarea')].find((each) => each.offsetParent !== null)
  if (!field) return
  if (draft.text) {
    field.value = draft.text
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (draft.hadFocus) field.focus()
}
