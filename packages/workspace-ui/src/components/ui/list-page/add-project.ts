import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import { projectsStore } from '../../../contexts/projects/projects.store.svelte'
import { projectDirLabel } from '../../../lib/paths'
import type { ListProjectOption } from './list-page'

/**
 * A project only reaches a scope menu once something happened in it, which
 * leaves no way to scope a page to a folder that is on disk but has never been
 * opened. The app shell owns the one directory picker on both desktop and web,
 * so this asks it to browse with the "add a project" intent rather than
 * mounting a second picker on every list page. The added project comes back in
 * the scope menu's own vocabulary so the page can select it at once.
 */
export function openAddProjectPicker(onAdded?: (option: ListProjectOption) => void): void {
  window.dispatchEvent(
    new CustomEvent('solus:open-directory-picker', {
      detail: {
        intent: 'add-project',
        onProjectAdded: (project: ProjectRef) => {
          onAdded?.({
            key: projectsStore.projectKeyFor(project.serverId, project.projectRoot),
            projectKey: project.projectRoot,
            serverId: project.serverId,
            label: projectDirLabel(project.projectRoot, null),
            available: true,
            historyOnly: true,
          })
        },
      },
    }),
  )
}
