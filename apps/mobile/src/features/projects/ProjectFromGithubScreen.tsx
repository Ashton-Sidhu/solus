// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SetupGithubRepo } from '@solus/contracts/types'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, ListRow, ListSection, ListStateCard, LIST_ROW_ICON_SIZE } from './components/add-project-ui'
import { GithubProjectIcon } from './components/GithubProjectIcon'
import { matchingRepos } from './lib/open-project'
import { errorText, useHostApi } from './use-open-project'

type Repos =
  | { kind: 'loading' }
  | { kind: 'loaded'; repos: SetupGithubRepo[] }
  | { kind: 'not-connected' }
  | { kind: 'error'; message: string }

/** The repositories the host's GitHub account can reach, as T3 Code's repository source; one tap clones it into the projects folder. */
export function ProjectFromGithubScreen({ navigation, route }: ScreenProps<'ProjectFromGithub'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  const [state, setState] = useState<Repos>({ kind: 'loading' })
  const [query, setQuery] = useState('')
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


  return (
    <AddProjectShell title="GitHub" onRefresh={reload}>
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
              subtitle={repo.private ? 'Private' : undefined}
              icon={<GithubProjectIcon size={LIST_ROW_ICON_SIZE} colorClassName="accent-icon-muted" />}
              isFirst={index === 0}
              disabled={!api}
              accessibilityHint="Choose where to clone this repository"
              onPress={() => navigation.navigate('CloneDestination', { hostId, remoteUrl: repo.cloneUrl, repositoryTitle: repo.fullName })}
            />
          ))}
        </ListSection>
      ) : null}
    </AddProjectShell>
  )
}
