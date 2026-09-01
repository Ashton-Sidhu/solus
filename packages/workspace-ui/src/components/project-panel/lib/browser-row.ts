/**
 * The Browser row's caret clears a browser profile, and a browser profile
 * belongs to a *project* — every worktree of that project shares one login
 * (`browserPartition` in the contract says so). The row sits under a branch
 * header, so a bare "Clear browser data" would read as clearing this branch's
 * data and understate what it wipes. Both strings therefore name the project.
 */
export function browserProfileProject(projectRoot: string | null | undefined): string | null {
  if (!projectRoot || projectRoot === '~') return null
  const name = projectRoot.replace(/\/+$/, '').split('/').pop()
  return name ? name : null
}

export function clearBrowserDataLabel(project: string | null): string {
  return project ? `Clear browser data for ${project}` : 'Clear browser data'
}

export function confirmClearBrowserDataLabel(project: string | null): string {
  return project ? `Clear ${project}'s browser data?` : 'Clear browser data?'
}

export function clearedBrowserDataLabel(project: string | null): string {
  return project ? `Cleared ${project}'s browser data` : 'Cleared the browser data'
}

/**
 * Whether the Browser row is armed to clear, given which project it was armed
 * for and which one the panel now describes.
 *
 * Armed *for a project* rather than as a bare flag: this panel retargets when
 * the user moves to another session, and a boolean would stay armed across that
 * move — the second click would then wipe a project the user never pointed at.
 */
export function isClearBrowserArmed(
  armedFor: string | null,
  projectRoot: string | null | undefined,
): boolean {
  return !!projectRoot && armedFor === projectRoot
}
