import { useEffect, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { RUN_PROFILE_PRESETS, commandSigningTeam, draftConfiguration, draftForPreset, fitPresetToProject, needsSigningTeam, presetFor, profileDraft, profilesFromDrafts, profileSummary, saveRunProfiles, signingTeamHint, withConfiguration, withSigningTeam, type RunProfileDraft } from '@solus/client-core/device-run-profiles'
import type { DeviceRunProfile, DeviceSigningTeam } from '@solus/contracts/device-types'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { ControlPill } from '../../components/ControlPill'
import { ErrorBanner } from '../../components/ErrorBanner'
import { SegmentedControl } from '../../components/SegmentedControl'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListStateCard, SectionTitle } from '../projects/components/add-project-ui'
import { folderNameOf } from '../projects/lib/open-project'
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
  const [adding, setAdding] = useState(false)
  /** How many profiles the project had: saving nothing over nothing would only look like a setup. */
  const [savedCount, setSavedCount] = useState(0)
  /** The Apple teams the host can sign phone builds for. An older host offers none; the person types one. */
  const [teams, setTeams] = useState<DeviceSigningTeam[]>([])
  /** The profile open for editing. A new one opens; saved ones start closed. */
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    if (!api) return
    let live = true
    api.projectConfigLoad(projectPath).then(
      (config) => {
        if (!live) return
        setDrafts((config?.deviceRuns ?? []).map(profileDraft))
        setSavedCount(config?.deviceRuns?.length ?? 0)
        setLoaded({ kind: 'loaded' })
      },
      (cause: unknown) => { if (live) setLoaded({ kind: 'error', message: errorText(cause) }) },
    )
    api.deviceSigningTeams().then((found) => { if (live) setTeams(found) }, () => {})
    return () => { live = false }
  }, [api, projectPath])

  const change = (index: number, fields: Partial<RunProfileDraft>) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...fields } : draft)))
  }

  // A preset starts in the folder the app is in (a monorepo's apps/mobile/ios), with the Xcode workspace there.
  const add = async (profile: DeviceRunProfile) => {
    if (!api || adding) return
    setAdding(true)
    try {
      const fitted = await fitPresetToProject(api, projectPath, profile)
      setOpenIndex(drafts.length)
      setDetailsOpen(false)
      setDrafts((current) => [...current, profileDraft(fitted)])
    } finally {
      setAdding(false)
    }
  }

  // Building for something else takes that preset's command, folder and output, fitted to the project.
  const buildFor = async (index: number, label: string) => {
    const draft = drafts[index]
    const preset = RUN_PROFILE_PRESETS.find((candidate) => candidate.label === label)
    if (!api || !draft || !preset || adding || presetFor(draft) === preset) return
    setAdding(true)
    try {
      const next = await draftForPreset(api, projectPath, draft, preset)
      setDrafts((current) => current.map((candidate, at) => (at === index ? next : candidate)))
    } finally {
      setAdding(false)
    }
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
          <SectionTitle>{`How ${folderNameOf(projectPath)} builds`}</SectionTitle>
          <Text className="px-1 text-xs leading-snug text-foreground-muted">Each profile is one way to build the app. Pick one from New build to build it.</Text>
          {/* One card per profile, closed to a line that says what it builds. It opens to
              edit; the command and paths come from the preset and wait under Build details. */}
          {drafts.map((draft, index) => {
            const isOpen = openIndex === index
            return (
              <View key={index} className="gap-2.5 rounded-[20px] bg-grouped-card px-4 py-3.5">
                <View className="flex-row items-center gap-2">
                  <Pressable
                    className="min-w-0 flex-1 flex-row items-center gap-2"
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isOpen }}
                    accessibilityHint={isOpen ? 'Closes this profile' : 'Opens this profile to edit it'}
                    onPress={() => { setOpenIndex(isOpen ? null : index); setDetailsOpen(false) }}
                  >
                    <SymbolView name={isOpen ? 'chevron.down' : 'chevron.right'} size={13} tintColorClassName="accent-icon-muted" type="monochrome" />
                    <View className="min-w-0 flex-1">
                      <Text numberOfLines={1} className="font-medium text-foreground">{draft.name || 'Unnamed profile'}</Text>
                      <Text numberOfLines={1} className="text-xs text-foreground-muted">{profileSummary(draft, teams)}</Text>
                    </View>
                  </Pressable>
                  <ControlPill variant="danger" icon="trash" accessibilityLabel={`Remove ${draft.name || 'this profile'}`} onPress={() => { setDrafts((current) => current.filter((_, at) => at !== index)); setOpenIndex(null) }} />
                </View>
                {isOpen ? (
                  <>
                    <Field label="Name" value={draft.name} placeholder="iOS simulator" onChange={(name) => change(index, { name })} />
                    <Text className="px-1 text-xs text-foreground-muted">Builds for</Text>
                    <SegmentedControl
                      options={RUN_PROFILE_PRESETS.map((preset) => ({ value: preset.label, label: preset.label === 'iOS Simulator' ? 'Simulator' : preset.label }))}
                      selected={presetFor(draft).label}
                      onSelect={(label) => void buildFor(index, label)}
                    />
                    {draftConfiguration(draft) ? (
                      <>
                        <Text className="px-1 text-xs text-foreground-muted">Configuration</Text>
                        <SegmentedControl
                          options={[{ value: 'Debug', label: 'Debug' }, { value: 'Release', label: 'Release' }]}
                          selected={draftConfiguration(draft) ?? 'Debug'}
                          onSelect={(configuration) => change(index, withConfiguration(draft, configuration))}
                        />
                        <Text className="px-1 text-xs leading-snug text-foreground-muted">{draftConfiguration(draft) === 'Debug' ? 'For development. An Expo or React Native app loads its JavaScript from Metro.' : 'The app as people get it, with its JavaScript bundled in.'}</Text>
                      </>
                    ) : null}
                    {needsSigningTeam(draft) ? (
                      <View className="gap-1.5">
                        <Text className="px-1 text-xs text-foreground-muted">Signing team</Text>
                        {teams.length ? (
                          <View className="flex-row flex-wrap gap-2">
                            {teams.map((team) => (
                              <ControlPill
                                key={team.teamId}
                                variant={commandSigningTeam(draft.commandText) === team.teamId ? 'primary' : 'pill'}
                                label={`${team.name} · ${team.teamId}`}
                                accessibilityLabel={`Sign with ${team.name}`}
                                onPress={() => change(index, { commandText: withSigningTeam(draft.commandText, team.teamId) })}
                              />
                            ))}
                          </View>
                        ) : null}
                        <TextInput
                          autoCapitalize="characters"
                          autoCorrect={false}
                          value={commandSigningTeam(draft.commandText)}
                          placeholder={teams.length ? 'Or enter a team id' : 'Team id, such as A1B2C3D4E5'}
                          accessibilityLabel="Signing team id"
                          onChangeText={(teamId) => change(index, { commandText: withSigningTeam(draft.commandText, teamId) })}
                        />
                        <Text className="px-1 text-xs leading-snug text-foreground-muted">{signingTeamHint(teams)}</Text>
                      </View>
                    ) : null}
                    <View className="flex-row">
                      <ControlPill variant="pill" icon={detailsOpen ? 'chevron.down' : 'chevron.right'} label="Build details" accessibilityLabel={detailsOpen ? 'Hide build details' : 'Show build details'} onPress={() => setDetailsOpen((open) => !open)} />
                    </View>
                    {detailsOpen ? (
                      <>
                        <Field label="Folder" value={draft.cwd} placeholder="." onChange={(cwd) => change(index, { cwd })} />
                        <Field label="Command" value={draft.commandText} placeholder="xcodebuild -scheme App build" onChange={(commandText) => change(index, { commandText })} />
                        <Field label="Output" value={draft.artifact} placeholder="build/…/*.app or *.apk" onChange={(artifact) => change(index, { artifact })} />
                        <Field label="App ID" value={draft.appId} placeholder="Optional" onChange={(appId) => change(index, { appId })} />
                        <Text className="px-1 text-xs leading-snug text-foreground-muted">The command runs in the folder without a shell. A * in the output matches within one folder name; the newest match wins.</Text>
                      </>
                    ) : null}
                  </>
                ) : null}
              </View>
            )
          })}
          {/* No profile yet: the starting points are the first step. */}
          <SectionTitle>{drafts.length === 0 ? 'Start from a common build' : 'Add another profile'}</SectionTitle>
          {drafts.length === 0 ? <Text className="px-1 text-xs leading-snug text-foreground-muted">What does this project build for? Solus finds the app in the project and fills in the rest.</Text> : null}
          <View className="flex-row flex-wrap gap-2">
            {RUN_PROFILE_PRESETS.map((preset) => (
              <ControlPill key={preset.label} variant="pill" label={preset.label} accessibilityLabel={`Add the ${preset.label} profile`} disabled={adding} onPress={() => void add(preset.profile)} />
            ))}
          </View>
          <View className="flex-row pt-2">
            <ControlPill variant="primary" label={saving ? 'Saving...' : 'Save profiles'} accessibilityLabel="Save the build profiles" disabled={saving || (drafts.length === 0 && savedCount === 0)} onPress={() => void save()} />
          </View>
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
