import { MessageCircle } from '@lucide/svelte'
import { openChatDraft } from '../../../contexts/workspace/new-chat'
import type { Command } from './commands'
import { comboHint } from '../../../lib/keybindings/manifest'

/** "New chat", the same entry in every client's palette: a draft with no project. */
export function newChatCommand(workspace: Parameters<typeof openChatDraft>[0]): Command {
  return {
    id: 'new-chat',
    label: 'New chat',
    group: 'General',
    icon: MessageCircle,
    hint: comboHint('global.new-chat'),
    keywords: ['chat', 'no project', 'question', 'ask', 'new'],
    run: () => openChatDraft(workspace, 'palette'),
  }
}
