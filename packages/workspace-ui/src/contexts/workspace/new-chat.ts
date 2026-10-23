import type { Via } from '@solus/contracts/analytics-events'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { requestInputFocus } from '../../lib/inputFocus'
import type { WorkspaceContext } from './workspace.context.svelte'

/**
 * A new chat: a draft with no project in the leading pane, with the caret in
 * its composer (docs/projects.md, "Chats"). It runs on the host of the
 * conversation in front of the user, else on the Run on host. `seed` names
 * another host, and a prompt the person reads and sends themselves, as
 * "Set up with an agent" does (docs/plans/mcp-integrations.md §13.4).
 */
export function openChatDraft(
  workspace: Pick<WorkspaceContext, 'drafts' | 'router'>,
  via: Via = 'palette',
  seed: { serverId?: string; prompt?: string } = {},
): void {
  const draft = workspace.drafts.openSessionDraft(
    { freshTask: true, target: 'leading', via, serverId: seed.serverId },
    NEW_CHAT_DIRECTORY,
  )
  if (seed.prompt) draft.prompt.text = seed.prompt
  requestInputFocus()
}
