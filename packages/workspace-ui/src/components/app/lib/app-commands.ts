import { LayoutGrid as AppIcon, SlidersHorizontal as ManageIcon } from '@lucide/svelte'
import type { Command } from '../../command-palette/lib/commands'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import { appsStore, type AppRow } from '../../../contexts/apps/apps.store.svelte'
import { appIconsStore } from '../../../contexts/apps/app-icons.store.svelte'

type AppsShell = Pick<WorkspaceContext, 'openApp' | 'openAppManage' | 'openApps'>

/** One row of "Open app…" or "Manage app…", with the app's own icon when it has one. The host is named when the apps are on more than one. */
export function openAppCommand(row: AppRow, hostLabel: string | null, open: (row: AppRow) => void, id = `app:${row.serverId}:${row.app.id}`): Command {
  return {
    id,
    label: hostLabel ? `${row.app.name} · ${hostLabel}` : row.app.name,
    group: 'Apps',
    icon: AppIcon,
    image: appIconsStore.urlFor(row.serverId, row.app) ?? undefined,
    keywords: [row.app.name, row.app.slug, row.app.description],
    run: () => open(row),
  }
}

/**
 * "Apps" opens the Workspace page on its Apps tab; "Open app…" and "Manage
 * app…" list the apps of every connected host (docs/plans/apps.md §9.3).
 */
export function appsPaletteCommands(shell: AppsShell): Command[] {
  const rows = appsStore.rows
  const hasSeveralHosts = new Set(rows.map((row) => row.serverId)).size > 1
  const hostLabel = (row: AppRow) => (hasSeveralHosts ? serversStore.hostFor(row.serverId)?.label ?? row.serverId : null)
  return [{
    id: 'apps',
    label: 'Apps',
    group: 'View',
    icon: AppIcon,
    keywords: ['apps', 'workspace', 'personal cloud'],
    run: () => shell.openApps('palette'),
  }, {
    id: 'open-app',
    label: 'Open app…',
    group: 'View',
    icon: AppIcon,
    keywords: ['app', 'open'],
    children: rows.map((row) => openAppCommand(row, hostLabel(row), (target) => shell.openApp(target.serverId, target.app.slug, 'leading'))),
  }, {
    id: 'manage-app',
    label: 'Manage app…',
    group: 'View',
    icon: ManageIcon,
    keywords: ['app', 'manage', 'versions', 'deploy', 'activity', 'call log', 'secrets', 'schedules', 'workflows', 'signals'],
    children: rows.map((row) =>
      openAppCommand(row, hostLabel(row), (target) => shell.openAppManage(target.serverId, target.app.slug, undefined, 'leading'), `manage-app:${row.serverId}:${row.app.id}`)),
  }]
}
