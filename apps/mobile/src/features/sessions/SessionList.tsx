import { ActionSheetIOS, Alert, FlatList, Platform, RefreshControl, View } from 'react-native'
import type { AgentId, SessionRecord } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import { usePalette } from '../../theme/theme'
import { space } from '../../theme/tokens'
import { Banner, Button, EmptyState, Row } from '../../ui/primitives'
import type { SelectedConversation } from '../../navigation/routes'
import { useKeyboardCommand } from '../keyboard/use-keyboard-command'
import { useSessionListRefresh } from './use-session-list-refresh'
import { PROVIDERS } from '../conversation/lib/run-settings'
import { chatFolderIn, isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { useProjectsFolder } from '../projects/use-open-project'

export function recordOf(record: SessionRecord): Extract<SelectedConversation, { record: unknown }>['record'] {
  return {
    sessionId: record.sessionId,
    provider: record.provider,
    projectPath: record.projectPath,
    cwd: record.cwd,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    title: record.title,
    customTitle: record.customTitle,
  }
}

function relativeTime(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString()
}

/** A project's sessions, or the host's chats, newest first, and the way to start one. */
export function SessionList({ hostId, projectPath, selectedId, onSelect }: {
  hostId: string
  projectPath: string
  selectedId: string | null
  onSelect: (selected: SelectedConversation) => void
}) {
  const app = useApp()
  const palette = usePalette()
  const state = useListened(app.sessions.changes, () => app.sessions.sessionsOf(hostId, projectPath))
  useSessionListRefresh(hostId, projectPath)

  const inChats = isChat(projectPath)
  const projectsFolder = useProjectsFolder(hostId)
  // A new chat runs in its own folder, named now from the new session; the host
  // names the same folder itself when it has not said where its projects are.
  const folderFor = (sessionId: string) => !inChats
    ? projectPath
    : projectsFolder && projectsFolder !== '~' ? chatFolderIn(projectsFolder, sessionId) : NEW_CHAT_DIRECTORY
  const start = (provider: AgentId) => {
    const sessionId = app.newSessionId()
    onSelect({ newSession: { sessionId, provider, workingDirectory: folderFor(sessionId) } })
  }
  const startTitle = inChats ? 'Start a chat with' : 'Start a session with'
  const chooseProvider = () => {
    const labels = PROVIDERS.map((provider) => provider.label)
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: startTitle, options: [...labels, 'Cancel'], cancelButtonIndex: labels.length }, (index) => {
        const provider = PROVIDERS[index]
        if (provider) start(provider.id)
      })
    } else {
      Alert.alert(startTitle, undefined, [
        ...PROVIDERS.map((provider) => ({ text: provider.label, onPress: () => start(provider.id) })),
        { text: 'Cancel', style: 'cancel' as const },
      ])
    }
  }

  useKeyboardCommand('newSession', chooseProvider)

  const items = state.kind === 'loaded' ? state.items : state.kind === 'idle' ? [] : state.previous ?? []
  const now = Date.now()
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      data={items}
      keyExtractor={(record) => record.sessionId}
      ListHeaderComponent={<View style={{ padding: space.lg, gap: space.sm }}>
        <Button tone="primary" label={inChats ? 'New chat' : 'New session'} onPress={chooseProvider} />
        {state.kind === 'error' ? <Banner message={`Sessions could not be read: ${state.message}`} /> : null}
      </View>}
      ListEmptyComponent={state.kind === 'loaded'
        ? inChats
          ? <EmptyState title="No chats yet" message="Start a chat to ask an agent anything." />
          : <EmptyState title="No sessions yet" message="Start a session to give an agent work in this project." />
        : null}
      refreshControl={<RefreshControl refreshing={state.kind === 'loading'} onRefresh={() => void app.sessions.loadSessions(hostId, projectPath)} />}
      renderItem={({ item }) => (
        <View style={{ backgroundColor: item.sessionId === selectedId ? palette.accentSoft : 'transparent' }}>
          <Row
            title={item.customTitle || item.title || item.slug || 'Untitled session'}
            subtitle={[item.provider === 'codex' ? 'Codex' : 'Claude Code', item.status === 'running' ? 'Running' : null, relativeTime(item.lastActivityAt, now)].filter(Boolean).join(' · ')}
            onPress={() => onSelect({ record: recordOf(item) })}
          />
        </View>
      )}
    />
  )
}
