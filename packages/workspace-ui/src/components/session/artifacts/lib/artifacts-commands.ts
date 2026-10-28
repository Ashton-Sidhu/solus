import { Boxes } from '@lucide/svelte'
import type { Command } from '../../../command-palette/lib/commands'
import type { WorkspaceContext } from '../../../../contexts/workspace/workspace.context.svelte'
import { comboHint } from '../../../../lib/keybindings/manifest'

type ArtifactsShell = Pick<WorkspaceContext, 'focusedChatTabId' | 'sessionFor' | 'openArtifacts'>

/** "Open artifacts", beside the focused conversation or as the destination.
 *  Offered only while a conversation has focus. */
export function artifactsPaletteCommands(shell: ArtifactsShell): Command[] {
  const sessionId = shell.focusedChatTabId ? shell.sessionFor(shell.focusedChatTabId)?.id : undefined
  if (!sessionId) return []
  const keywords = ['artifacts', 'outputs', 'linked', 'pull requests', 'works', 'files', 'images', 'automations']
  return [{
    id: 'open-artifacts',
    label: 'Open artifacts',
    group: 'View',
    icon: Boxes,
    hint: comboHint('conversation.open-artifacts'),
    keywords,
    run: () => shell.openArtifacts(sessionId),
  }, {
    id: 'open-artifacts-main',
    label: 'Open artifacts in main pane',
    group: 'View',
    icon: Boxes,
    keywords,
    run: () => shell.openArtifacts(sessionId, 'leading'),
  }]
}
