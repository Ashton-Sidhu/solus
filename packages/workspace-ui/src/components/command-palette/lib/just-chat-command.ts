import { MessageCircle } from '@lucide/svelte'
import { openScratchpadDraft } from '../../../contexts/workspace/just-chat'
import type { Command } from './commands'

/** "Just chat", the same entry in every client's palette: a new draft in Scratchpad. */
export function justChatCommand(workspace: Parameters<typeof openScratchpadDraft>[0]): Command {
  return {
    id: 'just-chat',
    label: 'Just chat',
    group: 'General',
    icon: MessageCircle,
    keywords: ['scratchpad', 'chat', 'no project', 'question', 'ask', 'new'],
    run: () => void openScratchpadDraft(workspace, 'palette'),
  }
}
