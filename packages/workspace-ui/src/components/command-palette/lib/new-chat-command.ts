import { MessageCircle } from '@lucide/svelte'
import { openChatDraft } from '../../../contexts/workspace/new-chat'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { effectiveCombo } from '../../../lib/keybindings/editing'
import { formatComboText } from '../../../lib/keybindings/match'
import type { Command } from './commands'

/** "New chat", the same entry in every client's palette: a draft with no project. */
export function newChatCommand(workspace: Pick<WorkspaceContext, 'drafts' | 'router' | 'settings'>): Command {
  return {
    id: 'new-chat',
    label: 'New chat',
    group: 'General',
    icon: MessageCircle,
    get hint() {
      const combo = effectiveCombo('global.new-chat', workspace.settings.keybindings)
      return combo ? formatComboText(combo) : undefined
    },
    keywords: ['chat', 'no project', 'question', 'ask', 'new'],
    run: () => openChatDraft(workspace, 'palette'),
  }
}
