import type { AppPermissions } from '@solus/contracts/apps'
import type { UpstreamTool } from '../integrations/gateway'

/** Whether the app's own permissions admit a tool (docs/plans/apps.md §5). Pure, so it is tested as data. */
export function admits(permissions: AppPermissions, name: string, tool: Pick<UpstreamTool, 'annotations'> | undefined): boolean {
  if (permissions.tools === 'all') return true
  if (permissions.tools === 'read-only') return tool?.annotations?.readOnlyHint === true
  return permissions.tools.selected.includes(name)
}
