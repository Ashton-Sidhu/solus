import type { AppPermissions } from '@solus/contracts/apps'

/** The two settings a person changes from the header (docs/plans/apps.md §5). */
export const TOOL_CHOICES = [
  { value: 'all', label: 'All tools' },
  { value: 'read-only', label: 'Read-only tools' },
] as const

export const WRITE_CHOICES = [
  { value: 'ask', label: 'Writes ask first' },
  { value: 'allow', label: 'Writes run on click' },
] as const

/** The header's value for the tools setting; a selected list is its own value, which no choice offers. */
export function toolsChoiceOf(permissions: AppPermissions): string {
  return permissions.tools === 'all' || permissions.tools === 'read-only' ? permissions.tools : 'selected'
}

export function toolsChoiceLabel(permissions: AppPermissions): string {
  if (permissions.tools === 'all') return 'All tools'
  if (permissions.tools === 'read-only') return 'Read-only tools'
  return `${permissions.tools.selected.length} selected tools`
}

export function writesChoiceLabel(permissions: AppPermissions): string {
  return permissions.writes === 'ask' ? 'Writes ask first' : 'Writes run on click'
}

/** The permissions after the header's tools choice; any other value leaves them as they are. */
export function withToolsChoice(permissions: AppPermissions, choice: string): AppPermissions {
  if (choice === 'all' || choice === 'read-only') return { ...permissions, tools: choice }
  return permissions
}

export function withWritesChoice(permissions: AppPermissions, choice: string): AppPermissions {
  return choice === 'ask' || choice === 'allow' ? { ...permissions, writes: choice } : permissions
}
