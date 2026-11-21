// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { AppText as Text } from '../../components/AppText'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, PrimaryActionButton } from './components/add-project-ui'
import { cloneUrlFromInput } from './lib/open-project'
import { useHostApi } from '../hosts/use-host-api'

/** Clones any repository the host can reach, as T3 Code's Git URL source. The host checks the address. */
export function CloneProjectScreen({ navigation, route }: ScreenProps<'CloneProject'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  const [input, setInput] = useState('')
  const cloneUrl = cloneUrlFromInput(input)

  const next = () => {
    if (!api || !cloneUrl) return
    navigation.navigate('CloneDestination', { hostId, remoteUrl: cloneUrl })
  }

  return (
    <AddProjectShell title="Git URL">
      <HostStatusBanner hostId={hostId} />
      <AddProjectTextInput
        accessibilityLabel="Repository URL"
        placeholder="https://github.com/org/repo.git"
        value={input}
        onChangeText={setInput}
        keyboardType="url"
        autoFocus
        returnKeyType="next"
        onSubmitEditing={next}
      />
      <Text className="px-1 text-sm leading-snug text-foreground-muted">You can also type owner/repo for a GitHub repository.</Text>
      <PrimaryActionButton label="Continue" disabled={!api || !cloneUrl} onPress={next} />
    </AddProjectShell>
  )
}
