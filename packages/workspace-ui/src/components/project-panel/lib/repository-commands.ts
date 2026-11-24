import { FolderGit2, FolderPlus } from '@lucide/svelte'
import type { Command } from '../../command-palette/lib/commands'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { canDriveSession } from '../../../contexts/sharing/resource-roles'
import { codebaseOf, runHost } from '../../../contexts/workspace/run-location'
import { hasSessionStarted } from '../../../lib/sessionUtils'
import { addSessionFolder } from './repository-actions'

type CommandWorkspace = Pick<WorkspaceContext, 'focusedSourceId' | 'activeTabId' | 'sessionFor' | 'runFor' | 'apiFor' | 'router'>

/**
 * Palette entries for the folders of the session in focus
 * (docs/plans/codebases.md §9), shared by desktop and web. Each one is in the
 * list only while it can act: a session that has not started has no folders on
 * its host, and a run with no codebase has no codebase page.
 */
export function repositoryCommands(workspace: CommandWorkspace): Command[] {
  const sourceId = workspace.focusedSourceId ?? workspace.activeTabId
  if (!sourceId) return []
  const session = workspace.sessionFor(sourceId)
  const run = workspace.runFor(sourceId)
  const codebaseId = codebaseOf(run)
  const hasStarted = !!session && hasSessionStarted(session)
  const commands: Command[] = []
  if (session && hasStarted && canDriveSession(runHost(run), session.id)) {
    commands.push({
      id: 'session-add-folder',
      label: 'Add folder to this session',
      group: 'General',
      icon: FolderPlus,
      keywords: ['attach', 'folder', 'directory', 'repository', 'codebase', 'session'],
      run: () => addSessionFolder(workspace, sourceId),
    })
  }
  if (codebaseId) {
    commands.push({
      id: 'open-session-codebase',
      label: 'Open codebase settings',
      group: 'General',
      icon: FolderGit2,
      keywords: ['codebase', 'folders', 'repositories', 'roots', 'settings'],
      run: () => workspace.router.navigate({ name: 'settings', params: { tab: 'codebases', codebase: codebaseId } }),
    })
  }
  return commands
}
