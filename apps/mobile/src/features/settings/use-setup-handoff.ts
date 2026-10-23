import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { SetupHandoff } from '@solus/contracts/integrations/setup-handoff'
import { useApp } from '../../app/app-context'
import type { RootStackParamList } from '../../navigation/routes'

/**
 * "Set up with an agent" (docs/plans/mcp-integrations.md §13.4) on mobile: the
 * prompt becomes the host's new-chat draft, and the new-chat screen opens on
 * it, so the person reads it and sends it. A draft already written there is
 * kept, with the prompt after it. The same capability as the desktop and web
 * connect dialog.
 */
export function useSetupHandoff(hostId: string): (handoff: SetupHandoff) => void {
  const app = useApp()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  return (handoff) => {
    const draftKey = `new-task:${NEW_CHAT_DIRECTORY}`
    const written = app.draft(hostId, draftKey).trim()
    const { prompt } = handoff
    app.saveDraft(hostId, draftKey, written ? `${written}\n\n${prompt}` : prompt)
    navigation.navigate('NewTask', { hostId, projectPath: NEW_CHAT_DIRECTORY })
  }
}
