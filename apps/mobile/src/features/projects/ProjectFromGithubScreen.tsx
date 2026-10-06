// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import type { SetupGithubRepo } from '@solus/contracts/types'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, ListRow, ListRowSymbol, ListSection, ListStateCard } from './components/add-project-ui'
import { matchingRepos } from './lib/open-project'
import { errorText, useHostApi, useMounted, useShowProject } from './use-open-project'

type Repos =
  | { kind: 'loading' }
  | { kind: 'loaded'; repos: SetupGithubRepo[] }
  | { kind: 'not-connected' }
  | { kind: 'error'; message: string }

/** The repositories the host's GitHub account can reach, as T3 Code's repository source; one tap clones it into the projects folder. */
export function ProjectFromGithubScreen({ navigation, route }: ScreenProps<'ProjectFromGithub'>) {
  const { hostId } = route.params
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
    <AddProjectShell onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {state.kind === 'not-connected' ? (
        <ListStateCard
          title="GitHub is not connected"
          detail="Connect GitHub on this host to clone its repositories."
          actionLabel="Connect GitHub"
          onAction={() => navigation.navigate('GitHubConnection', { hostId })}
        />
      ) : null}
      {state.kind === 'error' ? (
        <ListStateCard title="Repositories unavailable" detail={state.message} actionLabel="Try again" onAction={reload} />
      ) : null}
      {state.kind === 'loading' && api ? <ListStateCard title="Reading repositories" loading /> : null}
      {cloneError ? <ErrorBanner message={cloneError} /> : null}
      {state.kind === 'loaded' ? (
        <AddProjectTextInput
          accessibilityLabel="Search repositories"
          placeholder="Search repositories"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
        />
      ) : null}
      {state.kind === 'loaded' && repos.length === 0 ? (
        <ListStateCard
          title={query.trim() ? 'No matching repositories' : 'No repositories'}
          detail={query.trim() ? 'Try a different name.' : 'This GitHub account has no repositories yet.'}
        />
      ) : null}
      {repos.length > 0 ? (
        <ListSection>
          {repos.map((repo, index) => (
            <ListRow
              key={repo.cloneUrl}
              title={repo.fullName}
              subtitle={cloningUrl === repo.cloneUrl ? 'Cloning…' : repo.private ? 'Private' : undefined}
              icon={<ListRowSymbol name="arrow.triangle.branch" muted />}
              isFirst={index === 0}
              disabled={cloningUrl !== null && cloningUrl !== repo.cloneUrl}
              accessibilityHint="Copies this repository to the host and opens it"
              onPress={cloningUrl ? undefined : () => void clone(repo)}
              {...(cloningUrl === repo.cloneUrl ? { right: <ActivityIndicator colorClassName="accent-icon-muted" /> } : {})}
            />
          ))}
        </ListSection>
      ) : null}
    </AddProjectShell>
  )
}
