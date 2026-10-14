/**
 * The "Viewed" mark in a pull request diff's file header. The code host keeps
 * the marks (GitHub's own "Viewed" box), so the diff only reads and toggles
 * them through this.
 */
export interface DiffViewedFiles {
  stateFor(path: string): 'viewed' | 'unviewed' | 'dismissed' | 'unknown'
  toggle(path: string): void
  viewedCount(paths: readonly string[]): number
  /** Why the host refused the last change; the marks went back. */
  readonly writeError: string | null
}

/** The diff toolbar's line: "3 of 12 viewed", or why the last change failed. */
export interface ViewedFilesStatus {
  text: string
  /** The host's reason, shown on hover. Null when nothing failed. */
  error: string | null
}

export function viewedFilesStatus(viewedFiles: DiffViewedFiles, paths: readonly string[]): ViewedFilesStatus {
  if (viewedFiles.writeError) return { text: "Couldn't save viewed files", error: viewedFiles.writeError }
  return { text: `${viewedFiles.viewedCount(paths)} of ${paths.length} viewed`, error: null }
}

const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" fill="currentColor" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>`

/** The header control. The header is built outside Svelte, so this is DOM. */
export function buildViewedToggle(
  path: string,
  viewedFiles: DiffViewedFiles,
  onToggle: (path: string, viewed: boolean) => void,
): HTMLElement {
  const state = viewedFiles.stateFor(path)
  const viewed = state === 'viewed'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `labelled-action-btn header-action-btn viewed-toggle${viewed ? ' is-viewed' : ''}${state === 'dismissed' ? ' is-dismissed' : ''}`
  button.setAttribute('aria-pressed', String(viewed))
  button.setAttribute(
    'title',
    state === 'dismissed'
      ? 'This file changed after you viewed it'
      : viewed
        ? 'Mark as not viewed'
        : 'Mark as viewed',
  )
  const box = document.createElement('span')
  box.className = 'viewed-toggle-box'
  box.setAttribute('aria-hidden', 'true')
  if (viewed) box.innerHTML = CHECK_SVG
  const label = document.createElement('span')
  label.textContent = state === 'dismissed' ? 'Changed since viewed' : 'Viewed'
  button.append(box, label)
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onToggle(path, !viewed)
  })
  return button
}
