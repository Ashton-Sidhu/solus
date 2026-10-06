// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { AppText as Text } from '../../components/AppText'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, PrimaryActionButton } from './components/add-project-ui'
import { cloneUrlFromInput } from './lib/open-project'
import { errorText, useHostApi, useMounted, useShowProject } from './use-open-project'

/** Clones any repository the host can reach, as T3 Code's Git URL source. The host checks the address. */
export function CloneProjectScreen({ navigation, route }: ScreenProps<'CloneProject'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cloneUrl = cloneUrlFromInput(input)

  const clone = async () => {
    if (!api || !cloneUrl || busy) return
    setBusy(true)
    setError(null)
    try {
      const project = await api.setupCloneProject({ cloneUrl })
      showProject(project.path)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <AddProjectShell>
      <HostStatusBanner hostId={hostId} />
      {error ? <ErrorBanner message={error} /> : null}
      <AddProjectTextInput
        accessibilityLabel="Repository URL"
        placeholder="https://github.com/org/repo.git"
        value={input}
        onChangeText={setInput}
        keyboardType="url"
        autoFocus
        returnKeyType="go"
        onSubmitEditing={() => void clone()}
        editable={!busy}
      />
      <Text className="px-1 text-sm leading-snug text-foreground-muted">You can also type owner/repo for a GitHub repository.</Text>
      <PrimaryActionButton label="Clone" loading={busy} disabled={busy || !api || !cloneUrl} onPress={() => void clone()} />
    </AddProjectShell>
  )
}
