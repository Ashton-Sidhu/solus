import { FileText } from '@lucide/svelte'
import { activeSurface, type PaneEntry } from '../../../contexts/workspace/routing/location'
import type { Command } from '../../command-palette/lib/commands'
import { isMarkdownFile } from './markdown-file'

/** A file on one host, named the way the files route names it. */
export interface WorkspaceFileRef {
  serverId: string
  cwd: string
  path: string
}

/** What the palette needs from the workspace: the files on screen, and the command. */
interface SaveFileAsWorkSurface {
  router: { panes: readonly PaneEntry[]; focused: PaneEntry }
  saveFileAsWork(file: WorkspaceFileRef, content?: string): Promise<void>
}

/** The markdown file shown in the focused files pane, else in any pane. */
export function visibleMarkdownFile(router: SaveFileAsWorkSurface['router']): WorkspaceFileRef | null {
  for (const pane of [router.focused, ...router.panes]) {
    const ref = activeSurface(pane)
    if (ref?.name !== 'files' || !ref.params.path || !isMarkdownFile(ref.params.path)) continue
    return { serverId: ref.params.serverId, cwd: ref.params.cwd, path: ref.params.path }
  }
  return null
}

/**
 * The palette's "Save as work" command, the same on every client: it promotes
 * the markdown file on screen into a doc work. Absent when no files pane shows
 * a markdown file, so the palette never offers a command that cannot run.
 */
export function saveFileAsWorkCommands(surface: SaveFileAsWorkSurface): Command[] {
  const file = visibleMarkdownFile(surface.router)
  if (!file) return []
  return [{
    id: 'save-file-as-work',
    label: 'Save file as work',
    group: 'Works',
    icon: FileText,
    keywords: ['markdown', 'document', 'promote', 'folio', 'work', 'file'],
    run: () => void surface.saveFileAsWork(file),
  }]
}
