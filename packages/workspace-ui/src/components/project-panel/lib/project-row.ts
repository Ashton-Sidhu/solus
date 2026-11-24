/**
 * The trailing slot of the project row of the Environment section. The row
 * marks the host of the run: a glyph for this machine, the name for a
 * different one. With a codebase, the row also names the codebase
 * (docs/plans/codebases.md §9). `MenuRow` cuts a badge prefix first when the
 * rail is narrow, so the codebase gives way before the host and the label.
 * The tooltip is one line: the tooltip of a row does not keep a line break,
 * so its facts are joined with " · ", as the pull request row does.
 */
export interface ProjectRowTrailing {
  badge: string | undefined
  badgePrefix: string | undefined
  tooltip: string | undefined
}

export function projectRowTrailing(input: { codebaseName: string | null; hostLabel: string | undefined; isLocalHost: boolean }): ProjectRowTrailing {
  const { codebaseName, hostLabel, isLocalHost } = input
  const runsOn = hostLabel ? `Runs on ${hostLabel}` : undefined
  if (!codebaseName) return { badge: isLocalHost ? undefined : hostLabel, badgePrefix: undefined, tooltip: runsOn }
  const tooltip = [`Codebase ${codebaseName}`, runsOn].filter(Boolean).join(' · ')
  // A local host is a glyph, so the codebase is the one text of the slot.
  if (isLocalHost || !hostLabel) return { badge: codebaseName, badgePrefix: undefined, tooltip }
  // The no-break space stays at the end of the prefix: the row joins the two parts with nothing between them.
  return { badge: hostLabel, badgePrefix: `${codebaseName} ·\u00a0`, tooltip }
}
