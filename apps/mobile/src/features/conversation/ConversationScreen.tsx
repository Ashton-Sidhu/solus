import { useEffect, useLayoutEffect } from 'react'
import { useWindowDimensions } from 'react-native'
import { useListened } from '../../app/app-context'
import { Listeners } from '../../lib/listeners'
import { selectedKey, type ScreenProps } from '../../navigation/routes'
import { EmptyState } from '../../ui/primitives'
import { deriveLayout } from '../layout/lib/layout'
import { useConversation } from '../sessions/use-conversation'
import { ConversationPane } from './ConversationPane'
import { isChat } from '@solus/contracts/chat'

/** A conversation on a compact window. Growing the window returns it to the
 *  workspace, where the session list stays beside it. */
export function ConversationScreen({ navigation, route }: ScreenProps<'Conversation'>) {
  const { hostId, projectPath, selected } = route.params
  const window = useWindowDimensions()
  const layout = deriveLayout(window)
  const store = useConversation(hostId, projectPath, selected)
  const title = useListened(store?.meta ?? NO_LISTENERS, () => store?.controller.run.title ?? null)

  useLayoutEffect(() => {
    const fallback = isChat(projectPath) ? 'Chat' : 'Session'
    navigation.setOptions({ title: title ?? ('newSession' in selected ? `New ${fallback.toLowerCase()}` : fallback) })
  }, [navigation, projectPath, selected, title])

  useEffect(() => {
    if (layout.variant === 'split') navigation.popTo('Workspace', { hostId, projectPath, selected })
  }, [hostId, layout.variant, navigation, projectPath, selected])

  if (!store) return <EmptyState title="This host cannot be reached" message="Check the host's state in Hosts." />
  return <ConversationPane store={store} conversationId={selectedKey(selected)} />
}

/** A conversation that could not open has nothing to listen to. */
const NO_LISTENERS = new Listeners()
