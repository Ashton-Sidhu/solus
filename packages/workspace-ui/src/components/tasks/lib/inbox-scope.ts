import type { ListScopeOption } from '../../ui/list-page/list-page'

/**
 * The projects the inbox's rows actually came from, with how many rows each one
 * contributes. Built from the rows rather than from the project switcher, so
 * the menu never offers a project that could not change the list — the tasks
 * inbox merges native tasks, upstream tickets and pull requests, and only the
 * rows themselves know which projects are represented.
 *
 * A row may live in more than one project — the same upstream repository cloned
 * twice — and counts once against each. A project that is currently narrowing
 * the list keeps its row at zero, so a narrowing that emptied the inbox can
 * always be undone where it was made.
 */
export function inboxScopeOptions(
  rows: readonly { projectKeys: readonly string[] }[],
  labelFor: (projectKey: string) => string,
  selected: readonly string[] = [],
): ListScopeOption[] {
  const counts = new Map<string, number>(selected.map((projectKey) => [projectKey, 0]))
  for (const row of rows) {
    for (const projectKey of new Set(row.projectKeys)) {
      counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([projectKey, count]) => ({
      value: projectKey,
      projectKey,
      label: labelFor(projectKey),
      count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
