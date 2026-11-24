/**
 * The project row of the Environment section. The row shows one name: the
 * name of the codebase for a run in a codebase, else the name of the project
 * (docs/plans/codebases.md §9). Its trailing slot marks the host of the run:
 * a glyph for this machine, the name for a different one. The folders of the
 * run are in the menu of the row (`lib/environment-folders.ts`). The tooltip
 * is one line: the tooltip of a row does not keep a line break, so its facts
 * are joined with " · ", as the pull request row does.
 */
export interface ProjectRow {
  label: string
  /** The row names a codebase: it has the icon of a codebase, not the mark of a project. */
  isCodebase: boolean
  badge: string | undefined
  tooltip: string | undefined
}

export function projectRow(input: { projectName: string; codebaseName: string | null; hostLabel: string | undefined; isLocalHost: boolean }): ProjectRow {
  const { projectName, codebaseName, hostLabel, isLocalHost } = input
  const runsOn = hostLabel ? `Runs on ${hostLabel}` : undefined
  const badge = isLocalHost ? undefined : hostLabel
  if (!codebaseName) return { label: projectName, isCodebase: false, badge, tooltip: runsOn }
  // The row does not show the working folder of a run in a codebase, so the tooltip says where the run works.
  const tooltip = [`Codebase ${codebaseName}`, `Works in ${projectName}`, runsOn].filter(Boolean).join(' · ')
  return { label: codebaseName, isCodebase: true, badge, tooltip }
}
