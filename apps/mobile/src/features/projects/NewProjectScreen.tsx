import { useState } from 'react'
import { Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Banner, Button, Field } from '../../ui/primitives'
import { GroupedScroll } from '../../ui/grouped-rows'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { folderNameOf, newProjectLocationText } from './lib/open-project'
import { errorText, useHostApi, useMounted, useProjectsFolder, useShowProject } from './use-open-project'

/** A new, empty project in the host's projects folder. The location is the host's; it does not change here. */
export function NewProjectScreen({ navigation, route }: ScreenProps<'NewProject'>) {
  const { hostId } = route.params
  const app = useApp()
  const palette = usePalette()
  const api = useHostApi(hostId)
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label) ?? 'this host'
  const projectsFolder = useProjectsFolder(hostId)
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!api || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const project = await api.setupCreateProject({ name: name.trim() })
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
      <View style={{ gap: space.sm }}>
        <Field
          label="Project name"
          placeholder="My website"
          value={name}
          onChangeText={setName}
          autoCapitalize="sentences"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void create()}
          editable={!busy}
        />
        <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>
          {newProjectLocationText(name, projectsFolder ? folderNameOf(projectsFolder) : 'the projects folder', hostLabel)}
        </Text>
      </View>
      {error ? <Banner message={error} /> : null}
      <Button
        tone="primary"
        label={busy ? 'Creating…' : 'Create project'}
        busy={busy}
        disabled={!api || !name.trim()}
        onPress={() => void create()}
      />
    </GroupedScroll>
  )
}
