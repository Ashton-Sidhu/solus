/**
 * What project the picker is scoped to.
 *
 * `current` is the default and the reason this is not just a project key: the
 * picker opens where the user already is, so it has to *follow* the composer
 * rather than pin whatever project was current the first time it opened.
 * `all` and `project` are explicit choices the user made and keeps.
 */
export type PickerScope =
  | { kind: 'current' }
  | { kind: 'all' }
  | { kind: 'project'; projectKey: string }

/** The project key the list filters on, or null for every project. */
export function resolvePickerScope(
  scope: PickerScope,
  currentProjectKey: string | null,
): string | null {
  if (scope.kind === 'all') return null
  if (scope.kind === 'project') return scope.projectKey
  return currentProjectKey
}

/**
 * The scope a menu choice becomes.
 *
 * Choosing the project the composer is already in resumes following it rather
 * than pinning it. Without this, "back to this project" would silently stop
 * tracking the composer and the picker would go stale the next time the user
 * moved to another project.
 */
export function scopeForChoice(
  projectKey: string | null,
  currentProjectKey: string | null,
): PickerScope {
  if (projectKey === null) return { kind: 'all' }
  if (projectKey === currentProjectKey) return { kind: 'current' }
  return { kind: 'project', projectKey }
}
