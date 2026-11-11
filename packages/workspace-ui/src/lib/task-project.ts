// A task belongs to no project by itself: a project lists task sources, and
// one source can be in many projects (docs/plans/provider-owned-tasks.md
// §4.2). A surface that must name one project, or one folder, for a task asks
// here.

/** The one project a surface names for a task: `preferredProjectKey` when the
 *  task is in it, else the first project that lists the task. Null for a task
 *  that no known project lists. */
export function taskProjectKey(
  projectKeys: readonly string[],
  preferredProjectKey?: string | null,
): string | null {
  if (preferredProjectKey && projectKeys.includes(preferredProjectKey)) return preferredProjectKey
  return projectKeys[0] ?? null
}

/** The folder of a task's project on the host that reads the task. A path
 *  names a folder on one host only, so a checkout on another host is no
 *  answer. Null when that host holds no checkout of a project of the task. */
export function taskProjectRoot(
  projectKeys: readonly string[],
  serverId: string | null | undefined,
  checkoutsOf: (projectKey: string) => ReadonlyArray<{ serverId: string; projectRoot: string }>,
): string | null {
  if (!serverId) return null
  for (const projectKey of projectKeys) {
    const checkout = checkoutsOf(projectKey).find((candidate) => candidate.serverId === serverId)
    if (checkout) return checkout.projectRoot
  }
  return null
}
