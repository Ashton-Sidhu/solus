import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Alert, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { isChat } from '@solus/contracts/chat'
import type { DeviceRunProfile } from '@solus/contracts/device-types'
import { newBuildsRunning, profileTargetLabel, startDeviceRun } from '@solus/client-core/device-builds'
import { useApp, useListened } from '../../app/app-context'
import { ControlPill } from '../../components/ControlPill'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection, ListStateCard, SectionTitle } from '../projects/components/add-project-ui'
import { folderNameOf } from '../projects/lib/open-project'
import { errorText, useHostApi } from '../projects/use-open-project'
import { deviceErrorText, useDeviceState } from './use-device-state'

type Profiles =
  | { kind: 'loading' }
  | { kind: 'loaded'; profiles: DeviceRunProfile[] }
  | { kind: 'error'; message: string }

/**
 * New build from a phone (plan 016, S02): the person picks one of this
 * host's projects, then one of its saved build profiles. The host builds it
 * in the project folder and adds the output under Builds; it installs
 * nothing. The Builds screen shows the build while it runs.
 */
export function NewBuildScreen({ navigation, route }: ScreenProps<'NewBuild'>) {
  const { hostId, projectPath } = route.params
  useLayoutEffect(() => {
    if (projectPath) navigation.setOptions({ title: folderNameOf(projectPath) })
  }, [navigation, projectPath])
  return projectPath
    ? <ProfileList hostId={hostId} projectPath={projectPath} onStarted={() => navigation.popTo('Builds', { hostId })} onEditProfiles={() => navigation.push('BuildProfiles', { hostId, projectPath })} />
    : <ProjectList hostId={hostId} onPick={(path) => navigation.push('NewBuild', { hostId, projectPath: path })} />
}

/** This host's projects, as the New task project picker lists them. */
function ProjectList(props: { readonly hostId: string; readonly onPick: (path: string) => void }) {
  const app = useApp()
  const all = useListened(app.threads.changes, app.threads.projects)
  const projects = useMemo(() => all.filter((entry) => entry.hostId === props.hostId && !isChat(entry.project.path)), [all, props.hostId])
  return (
    <AddProjectShell>
      <HostStatusBanner hostId={props.hostId} />
      {projects.length === 0 ? (
        <ListStateCard title="No projects on this host" detail="Open a project on this host first; its builds start here." />
      ) : (
        <>
          <SectionTitle>Build which project?</SectionTitle>
          <ListSection>
            {projects.map((entry, index) => (
              <ListRow
                key={entry.key}
                title={entry.project.folderName}
                icon={<ListRowSymbol name="folder" muted />}
                isFirst={index === 0}
                accessibilityHint="Shows this project's build profiles"
                onPress={() => props.onPick(entry.project.path)}
              />
            ))}
          </ListSection>
        </>
      )}
    </AddProjectShell>
  )
}

/** The project's saved build profiles, each with what it builds for. */
function ProfileList(props: { readonly hostId: string; readonly projectPath: string; readonly onStarted: () => void; readonly onEditProfiles: () => void }) {
  const { hostId, projectPath, onStarted, onEditProfiles } = props
  const api = useHostApi(hostId)
  const { view } = useDeviceState(hostId)
  const [profiles, setProfiles] = useState<Profiles>({ kind: 'loading' })
  const [starting, setStarting] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])
  const running = newBuildsRunning(view.kind === 'loaded' ? view.state.runs : [], projectPath)
  // Back from the profile editor: read the saved profiles again.
  useFocusEffect(reload)

  useEffect(() => {
    if (!api) return
    let live = true
    setProfiles({ kind: 'loading' })
    api.projectConfigLoad(projectPath).then(
      (config) => { if (live) setProfiles({ kind: 'loaded', profiles: config?.deviceRuns ?? [] }) },
      (cause: unknown) => { if (live) setProfiles({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, projectPath, reloads])

  const start = async (profile: DeviceRunProfile) => {
    if (!api || starting) return
    setStarting(profile.name)
    try {
      const started = await startDeviceRun(api, { checkoutPath: projectPath, profileName: profile.name }, (question) => new Promise<boolean>((resolve) => {
        Alert.alert('Run this build command?', question, [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Run', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) })
      }))
      if (started) onStarted()
    } catch (cause) {
      Alert.alert(`Could not start ${profile.name}`, deviceErrorText(cause))
    } finally {
      setStarting(null)
    }
  }

  const list = profiles.kind === 'loaded' ? profiles.profiles : []
  return (
    <AddProjectShell onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {profiles.kind === 'error' ? <ErrorBanner message={`Build profiles could not be read: ${profiles.message}`} /> : null}
      {profiles.kind === 'loading' && api ? <ListStateCard title="Reading build profiles" loading /> : null}
      {profiles.kind === 'loaded' && list.length === 0 ? (
        <ListStateCard title="No build profiles" detail="Save how this project builds, then build it from here." actionLabel="Set up a build" onAction={onEditProfiles} />
      ) : null}
      {list.length > 0 ? (
        <>
          <SectionTitle>Build profile</SectionTitle>
          <ListSection>
            {list.map((profile, index) => (
              <ListRow
                key={profile.name}
                title={profile.name}
                subtitle={starting === profile.name ? 'Starting...' : running.has(profile.name) ? 'Building...' : profileTargetLabel(profile)}
                icon={<ListRowSymbol name="hammer" />}
                isFirst={index === 0}
                disabled={starting !== null || running.has(profile.name)}
                accessibilityHint="Builds the app and adds it to Builds"
                onPress={() => void start(profile)}
              />
            ))}
          </ListSection>
          <View className="flex-row">
            <ControlPill variant="pill" label="Edit build profiles" accessibilityLabel="Edit this project's build profiles" onPress={onEditProfiles} />
          </View>
        </>
      ) : null}
    </AddProjectShell>
  )
}
