import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native'
import type { SetupGithubRepo } from '@solus/contracts/types'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space } from '../../theme/tokens'
import { Banner, Button, EmptyState, Field, Row } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { matchingRepos } from './lib/open-project'
import { errorText, useHostApi, useMounted, useShowProject } from './use-open-project'

type Repos =
  | { kind: 'loading' }
  | { kind: 'loaded'; repos: SetupGithubRepo[] }
  | { kind: 'not-connected' }
  | { kind: 'error'; message: string }

/** The repositories the host's GitHub account can reach; one tap clones it into the projects folder. */
export function ProjectFromGithubScreen({ navigation, route }: ScreenProps<'ProjectFromGithub'>) {
  const { hostId } = route.params
  const palette = usePalette()
  const api = useHostApi(hostId)
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const [state, setState] = useState<Repos>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [cloningUrl, setCloningUrl] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useEffect(() => {
    if (!api) return
    let live = true
    setState({ kind: 'loading' })
    api.setupListGithubRepos().then(
      (result) => { if (live) setState(result.connected ? { kind: 'loaded', repos: result.repos } : { kind: 'not-connected' }) },
      (cause: unknown) => { if (live) setState({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, reloads])

  const repos = useMemo(() => state.kind === 'loaded' ? matchingRepos(state.repos, query) : [], [query, state])

  const clone = async (repo: SetupGithubRepo) => {
    if (!api || cloningUrl) return
    setCloningUrl(repo.cloneUrl)
    setCloneError(null)
    try {
      const project = await api.setupCloneProject({ cloneUrl: repo.cloneUrl })
      showProject(project.path)
    } catch (cause) {
      if (mounted.current) setCloneError(errorText(cause))
    } finally {
      if (mounted.current) setCloningUrl(null)
    }
  }

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: palette.canvas }}
      data={repos}
      keyExtractor={(repo) => repo.cloneUrl}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        <View style={{ padding: space.lg, gap: space.md }}>
          {state.kind === 'not-connected' ? (
            <Banner tone="info" message="GitHub is not connected on this host." action={<Button label="Connect GitHub" onPress={() => navigation.navigate('GitHubConnection', { hostId })} />} />
          ) : null}
          {state.kind === 'error' ? (
            <Banner message={`Repositories could not be read: ${state.message}`} action={<Button label="Try again" onPress={reload} />} />
          ) : null}
          {state.kind === 'loaded' ? (
            <Field label="Search repositories" placeholder="Search repositories" value={query} onChangeText={setQuery} returnKeyType="search" />
          ) : null}
          {cloneError ? <Banner message={cloneError} /> : null}
        </View>
      </>}
      ListEmptyComponent={state.kind === 'loading'
        ? (api ? <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading repositories" /></View> : null)
        : state.kind === 'loaded'
          ? <EmptyState title={query.trim() ? 'No matching repositories' : 'No repositories'} message={query.trim() ? 'Try a different name.' : 'This GitHub account has no repositories yet.'} />
          : null}
      renderItem={({ item }) => (
        <Row
          title={item.fullName}
          subtitle={cloningUrl === item.cloneUrl ? 'Cloning…' : item.private ? 'Private' : undefined}
          accessibilityHint="Copies this repository to the host and opens it"
          onPress={cloningUrl ? undefined : () => void clone(item)}
          trailing={cloningUrl === item.cloneUrl ? <ActivityIndicator /> : null}
        />
      )}
    />
  )
}
