import { useState } from 'react'
import type { ScreenProps } from '../../navigation/routes'
import { Banner, Button, Field } from '../../ui/primitives'
import { GroupedFooter, GroupedScroll } from '../../ui/grouped-rows'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { cloneUrlFromInput } from './lib/open-project'
import { errorText, useHostApi, useMounted, useShowProject } from './use-open-project'

/** Clones any repository the host can reach. The host checks the address. */
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
    if (!api || !cloneUrl) return
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
    <GroupedScroll>
      <HostStatusBanner hostId={hostId} />
      <Field
        label="Repository URL"
        placeholder="https://github.com/owner/repo"
        value={input}
        onChangeText={setInput}
        keyboardType="url"
        autoFocus
        returnKeyType="go"
        onSubmitEditing={() => void clone()}
        editable={!busy}
      />
      <GroupedFooter text="You can also type owner/repo for a GitHub repository." />
      {error ? <Banner message={error} /> : null}
      <Button tone="primary" label={busy ? 'Cloning…' : 'Clone'} busy={busy} disabled={!api || !cloneUrl} onPress={() => void clone()} />
    </GroupedScroll>
  )
}
