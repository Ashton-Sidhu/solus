import { useEffect, useState } from 'react'
import { Alert, View } from 'react-native'
import { RUN_PROFILE_PRESETS, profileDraft, profilesFromDrafts, saveRunProfiles, type RunProfileDraft } from '@solus/client-core/device-run-profiles'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { ControlPill } from '../../components/ControlPill'
import { ErrorBanner } from '../../components/ErrorBanner'
import { SegmentedControl } from '../../components/SegmentedControl'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListStateCard, SectionTitle } from '../projects/components/add-project-ui'
import { errorText, useHostApi } from '../projects/use-open-project'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'loaded' }
  | { kind: 'error'; message: string }

/**
 * A project's build profiles, edited on the phone (plan 016, S02): the same
 * profiles, presets and checks as the Devices pane on a computer. A preset
 * is a starting point; the scheme and folders are edited to fit the project.
 * Save writes them to the project's `.solus/config.json`.
 */
export function BuildProfilesScreen({ navigation, route }: ScreenProps<'BuildProfiles'>) {
  const { hostId, projectPath } = route.params
  const api = useHostApi(hostId)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [drafts, setDrafts] = useState<RunProfileDraft[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!api) return
    let live = true
    api.projectConfigLoad(projectPath).then(
      (config) => {
        if (!live) return
        setDrafts((config?.deviceRuns ?? []).map(profileDraft))
        setLoaded({ kind: 'loaded' })
      },
      (cause: unknown) => { if (live) setLoaded({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, projectPath])

  const change = (index: number, fields: Partial<RunProfileDraft>) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...fields } : draft)))
  }

  const save = async () => {
    if (!api || saving) return
    const checked = profilesFromDrafts(drafts)
    if ('error' in checked) {
      Alert.alert('Check the build profiles', checked.error)
      return
    }
    setSaving(true)
    try {
      await saveRunProfiles(api, projectPath, checked.profiles)
      navigation.goBack()
    } catch (cause) {
      Alert.alert('Could not save the build profiles', errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AddProjectShell>
      <HostStatusBanner hostId={hostId} />
      {loaded.kind === 'error' ? <ErrorBanner message={`Build profiles could not be read: ${loaded.message}`} /> : null}
      {loaded.kind === 'loading' && api ? <ListStateCard title="Reading build profiles" loading /> : null}
      {loaded.kind === 'loaded' ? (
        <>
          {drafts.map((draft, index) => (
            <View key={index} className="gap-2.5 rounded-[20px] bg-grouped-card px-4 py-3.5">
              <View className="flex-row items-center gap-2">
                <TextInput className="min-w-0 flex-1" value={draft.name} onChangeText={(name) => change(index, { name })} placeholder="Name" accessibilityLabel="Profile name" />
                <ControlPill variant="danger" icon="trash" accessibilityLabel={`Remove ${draft.name || 'this profile'}`} onPress={() => setDrafts((current) => current.filter((_, at) => at !== index))} />
              </View>
              <SegmentedControl
                options={[{ value: 'ios', label: 'iOS' }, { value: 'android', label: 'Android' }]}
                selected={draft.platform}
                onSelect={(platform) => change(index, { platform, target: platform === 'android' ? 'any' : draft.target === 'any' ? 'device' : draft.target })}
              />
              {draft.platform === 'ios' ? (
                <SegmentedControl
                  options={[{ value: 'device', label: 'iPhone or iPad' }, { value: 'simulator', label: 'Simulator' }]}
                  selected={draft.target === 'simulator' ? 'simulator' : 'device'}
                  onSelect={(target) => change(index, { target })}
                />
              ) : null}
              <Field label="Folder" value={draft.cwd} placeholder="." onChange={(cwd) => change(index, { cwd })} />
              <Field label="Command" value={draft.commandText} placeholder="xcodebuild -scheme App build" onChange={(commandText) => change(index, { commandText })} />
              <Field label="Output" value={draft.artifact} placeholder="build/…/*.app or *.apk" onChange={(artifact) => change(index, { artifact })} />
              <Field label="App ID" value={draft.appId} placeholder="Optional" onChange={(appId) => change(index, { appId })} />
            </View>
          ))}
          <SectionTitle>Add a profile</SectionTitle>
          <View className="flex-row flex-wrap gap-2">
            {RUN_PROFILE_PRESETS.map((preset) => (
              <ControlPill key={preset.label} variant="pill" label={preset.label} accessibilityLabel={`Add the ${preset.label} profile`} onPress={() => setDrafts((current) => [...current, profileDraft(preset.profile)])} />
            ))}
          </View>
          <View className="flex-row pt-2">
            <ControlPill variant="primary" label={saving ? 'Saving...' : 'Save'} accessibilityLabel="Save the build profiles" disabled={saving} onPress={() => void save()} />
          </View>
          <Text className="px-1 text-xs leading-snug text-foreground-muted">The command runs in the folder without a shell. A * in the output matches within one folder name; the newest match wins.</Text>
        </>
      ) : null}
    </AddProjectShell>
  )
}

function Field(props: { readonly label: string; readonly value: string; readonly placeholder: string; readonly onChange: (value: string) => void }) {
  return (
    <View className="gap-1">
      <Text className="px-1 text-xs text-foreground-muted">{props.label}</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} value={props.value} placeholder={props.placeholder} onChangeText={props.onChange} accessibilityLabel={props.label} />
    </View>
  )
}
