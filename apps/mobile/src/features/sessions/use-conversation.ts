import { useEffect, useMemo } from 'react'
import { useApp } from '../../app/app-context'
import type { SelectedConversation } from '../../navigation/routes'
import type { ConversationStore } from '../conversation/conversation-store'

/** The open conversation for a selection, remembered as the route to restore. */
export function useConversation(hostId: string, projectPath: string, selected: SelectedConversation): ConversationStore | null {
  const app = useApp()
  const store = useMemo(() => app.conversation(hostId, selected), [app, hostId, selected])
  useEffect(() => {
    // A new session is restored once it exists on the host, as a saved session.
    if ('record' in selected) app.rememberRoute({ hostId, projectPath, record: selected.record })
    else app.rememberRoute({ hostId, projectPath })
  }, [app, hostId, projectPath, selected])
  return store
}
