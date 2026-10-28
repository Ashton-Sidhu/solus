import { FolderTree } from '@lucide/svelte'
import type { PersonalSettings } from '@solus/contracts/settings'
import type { Command } from '../../command-palette/lib/commands'

/** The palette entry that switches the session sidebar between its two views
 *  (docs/plans/sidebar-project-view.md). Shared by desktop and web; the label
 *  names the view it switches to. */
export function sidebarViewCommand(settings: {
  readonly sidebarView: PersonalSettings['sidebarView']
  setPersonal(key: 'sidebarView', value: PersonalSettings['sidebarView']): boolean
}): Command {
  const next = settings.sidebarView === 'project' ? 'status' : 'project'
  return {
    id: 'toggle-sidebar-view',
    label: next === 'project' ? 'Group sidebar by project' : 'Group sidebar by status',
    group: 'View',
    icon: FolderTree,
    keywords: ['sidebar', 'view', 'group', 'project', 'folder', 'status', 'sessions'],
    run: () => void settings.setPersonal('sidebarView', next),
  }
}
