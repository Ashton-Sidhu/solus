import { LayoutGrid as AppIcon } from '@lucide/svelte'
import type { Command } from '../../command-palette/lib/commands'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import { appsStore, type AppRow } from '../../../contexts/apps/apps.store.svelte'

type AppsShell = Pick<WorkspaceContext, 'openApp' | 'openApps'>

/** One row of "Open app…". The host is named when the apps are on more than one. */
export function openAppCommand(row: AppRow, hostLabel: string | null, open: (row: AppRow) => void): Command {
  return {
    id: `app:${row.serverId}:${row.app.id}`,
    label: hostLabel ? `${row.app.name} · ${hostLabel}` : row.app.name,
    group: 'Apps',
    icon: AppIcon,
    keywords: [row.app.name, row.app.slug, row.app.description],
    run: () => open(row),
  }
}

/** "Apps" opens the Workspace page on its Apps tab; "Open app…" lists the apps of every connected host. */
export function appsPaletteCommands(shell: AppsShell): Command[] {
  const rows = appsStore.rows
  const hasSeveralHosts = new Set(rows.map((row) => row.serverId)).size > 1
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
    children: rows.map((row) =>
      openAppCommand(row, hasSeveralHosts ? serversStore.hostFor(row.serverId)?.label ?? row.serverId : null, (target) =>
        shell.openApp(target.serverId, target.app.slug, 'leading'))),
  }]
}
