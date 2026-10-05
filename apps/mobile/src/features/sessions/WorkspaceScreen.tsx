import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { selectedKey, type ScreenProps, type SelectedConversation } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { EmptyState } from '../../ui/primitives'
import { SymbolButton } from '../../ui/app-symbol'
import { ConversationPane } from '../conversation/ConversationPane'
import { deriveLayout } from '../layout/lib/layout'
import { SessionList } from './SessionList'
import { useConversation } from './use-conversation'
import { useKeyboardCommand } from '../keyboard/use-keyboard-command'
import { isChat } from '@solus/contracts/chat'

/**
 * A project's sessions, or the host's chats. With room (iPad full screen or a wide multitasking
 * window) the session list stays beside the conversation; otherwise the list
 * is a screen and a conversation is pushed over it. A resize moves between
 * the two without losing the selection, the draft, or the scroll position.
 */
export function WorkspaceScreen({ navigation, route }: ScreenProps<'Workspace'>) {
  const { hostId, projectPath, selected } = route.params
  const palette = usePalette()
  const window = useWindowDimensions()
  const layout = deriveLayout(window)
  const selectedRef = useRef(selected)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  selectedRef.current = selected

  // Chats have no project, so they have no files to browse.
  const inChats = isChat(projectPath)
  useLayoutEffect(() => {
    navigation.setOptions({
      title: inChats ? 'Chats' : projectPath.split('/').filter(Boolean).pop() ?? 'Sessions',
      headerRight: inChats ? undefined : () => <SymbolButton name="folder" label="Files" onPress={() => navigation.navigate('Files', { hostId, projectPath, folderPath: '' })} />,
    })
  }, [hostId, inChats, navigation, projectPath])

  // Shrinking to compact with a conversation open shows it as its own screen.
  useEffect(() => {
    const current = selectedRef.current
    if (layout.variant === 'compact' && current) {
      navigation.setParams({ selected: undefined })
      navigation.push('Conversation', { hostId, projectPath, selected: current })
    }
  }, [hostId, layout.variant, navigation, projectPath])

  const select = (next: SelectedConversation) => {
    if (layout.variant === 'compact') navigation.push('Conversation', { hostId, projectPath, selected: next })
    else navigation.setParams({ selected: next })
  }

  // ⌘B, as on desktop: only the split layout has a sidebar to hide.
  useKeyboardCommand('toggleSidebar', () => setSidebarHidden((hidden) => !hidden), layout.variant === 'split')

  const list = <SessionList hostId={hostId} projectPath={projectPath} selectedId={selected ? selectedKey(selected) : null} onSelect={select} />
  if (layout.variant === 'compact') return list
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: palette.canvas }}>
      {sidebarHidden ? null : <View style={{ width: layout.sidebarWidth, borderRightWidth: 1, borderRightColor: palette.border }}>{list}</View>}
      <View style={{ flex: 1 }}>
        {selected
          ? <SelectedConversationPane hostId={hostId} projectPath={projectPath} selected={selected} />
          : inChats
            ? <EmptyState title="No chat selected" message="Choose a chat, or start a new one." />
            : <EmptyState title="No session selected" message="Choose a session, or start a new one." />}
      </View>
    </View>
  )
}

function SelectedConversationPane({ hostId, projectPath, selected }: { hostId: string; projectPath: string; selected: SelectedConversation }) {
  const store = useConversation(hostId, projectPath, selected)
  if (!store) return <EmptyState title="This host cannot be reached" message="Check the host's state in Hosts." />
  return <ConversationPane key={selectedKey(selected)} store={store} conversationId={selectedKey(selected)} />
}
