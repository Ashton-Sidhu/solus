import { afterEach, describe, expect, test } from 'bun:test'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers } from '@solus/workspace-ui/contexts/codebases/codebases.store.svelte'
import { hasRepositoriesToShow } from '@solus/workspace-ui/components/project-panel/lib/panel-items'
import type { TreeAgentRow } from '@solus/workspace-ui/components/project-panel/lib/rail-agents'
import {
  OBSERVED_FOLDER_NOTE,
  PLAIN_FOLDER_NOTE,
  candidateRows,
  childRepositoryNote,
  otherHostFolders,
  repositoryActionLabel,
  repositoryRowExpanded,
  repositoryRowReading,
  repositoryRows,
} from '@solus/workspace-ui/components/project-panel/lib/repositories-section'
import { useRepositoryReads } from '@solus/workspace-ui/components/project-panel/lib/repository-reads.svelte'
import { PLAIN_MEMBER_LINKS_NOTE } from '@solus/workspace-ui/components/input/lib/worktree-repositories'
import { tooltipDisplay } from '@solus/workspace-ui/components/ui/tooltip/content'

/**
 * The Repositories section of the project panel (docs/plans/codebases.md §9,
 * "Running session"): one row for the working directory and one for each
 * session folder, with the actions that the source of the folder allows.
 */

function folder(path: string, patch: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...patch }
}

const working = { path: '/code/shop/web', repositoryPath: '/code/shop/web', projectPath: '/code/shop/web', isLinkedPlainFolder: false }

function gitState(branch: string | null, lines?: { insertions: number; deletions: number; fileCount: number }): GitState {
  return {
    repoRoot: '/code/shop/api', headSha: 'abc', branch, targetBranch: 'main', upstreamRef: null, aheadCount: 0, behindCount: 0,
    uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: 0, mergeInProgress: false },
    ...(lines ? { branchChanges: lines } : {}),
  } as GitState
}

describe('the rows of the section', () => {
  test('the working directory is first, then each session folder in the order of the host', () => {
    const rows = repositoryRows({ working, folders: [folder('/code/shop/api'), folder('/code/libs/ui')], hasCodebase: true })
    expect(rows.map((row) => [row.kind, row.name])).toEqual([['working', 'web'], ['folder', 'api'], ['folder', 'ui']])
    expect(rows[0]!.actions).toEqual(['open-files'])
  })

  // Each row is a folder of its own: the files pane and the terminal must open there, not in the working directory.
  test('each row opens its own folder, and offers a terminal only where this client has one', () => {
    const folders = [folder('/code/shop/api'), folder('/code/notes', { state: 'plain', source: 'attached' })]
    const onDesktop = repositoryRows({ working, folders, hasCodebase: false, canOpenTerminal: true })
    expect(onDesktop.map((row) => row.actions.slice(0, 2))).toEqual([
      ['open-files', 'open-terminal'], ['open-files', 'open-terminal'], ['open-files', 'open-terminal'],
    ])
    // The web client, and a session on a different machine, have no terminal to open.
    const onWeb = repositoryRows({ working, folders, hasCodebase: false })
    expect(onWeb.flatMap((row) => row.actions)).not.toContain('open-terminal')
    expect(onWeb.every((row) => row.actions[0] === 'open-files')).toBe(true)
  })

  // The host refuses to detach a folder of the codebase, so the row does not offer it.
  test('a folder of the codebase has no action that changes the session', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/shop/api', { source: 'codebase' })], hasCodebase: true })
    expect(row!.actions).toEqual(['open-files'])
  })

  test('an attached folder can be detached, and added to the codebase of the session', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/tools', { source: 'attached' })], hasCodebase: true })
    expect(row!.actions).toEqual(['open-files', 'detach', 'add-to-codebase'])
  })

  test('a folder that a project tool made has the same actions as an attached one', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/new-app', { source: 'created' })], hasCodebase: true })
    expect(row!.actions).toEqual(['open-files', 'detach', 'add-to-codebase'])
  })

  test('a session with no codebase has none to add a folder to', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/tools', { source: 'attached' })], hasCodebase: false })
    expect(row!.actions).toEqual(['open-files', 'detach'])
  })

  // The agent was not given an observed folder: Solus only shows what a tool
  // changed there. The row says so and offers the way to give it.
  test('an observed folder is marked and offers Attach, not Detach', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/other', { source: 'observed', granted: false })], hasCodebase: true })
    expect(row!.isObserved).toBe(true)
    expect(row!.actions).toEqual(['open-files', 'attach', 'add-to-codebase'])
    expect(row!.note).toBe(OBSERVED_FOLDER_NOTE)
    // The row says "Not attached" in place of the branch. `MenuRow` joins a
    // badge prefix with no space, so a branch there read "mainNot attached".
    const reading = repositoryRowReading(row!, gitState('main'))
    expect(reading.badge).toBe('Not attached')
    expect(reading).not.toHaveProperty('badgePrefix')
    expect(reading.tooltip).toContain('Branch main')
  })

  test('a folder with no repository offers Track with Git and says that it has no diff', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/notes', { state: 'plain', source: 'attached' })], hasCodebase: false })
    expect(row!.actions).toEqual(['open-files', 'detach', 'track-with-git'])
    expect(row!.note).toBe(PLAIN_FOLDER_NOTE)
    expect(repositoryRowReading(row!, null)).toMatchObject({ badge: 'No repository', diffStat: undefined })
  })

  // The list of the host is read at a turn start. After "Add to codebase" the
  // folder is in the record at once, so the row must not offer the action again.
  test('a folder that the codebase holds now is not offered again', () => {
    const [, row] = repositoryRows({
      working,
      folders: [folder('/code/tools', { source: 'attached' })],
      hasCodebase: true,
      isInCodebase: (path) => path === '/code/tools',
    })
    expect(row!.actions).toEqual(['open-files', 'detach'])
  })

  test('a worktree in a task folder is marked as isolated, and Git is read at the worktree', () => {
    const taskFolder = '/data/solus-task-folders/fix-login-1a2b3c4d'
    const rows = repositoryRows({
      working: { path: `${taskFolder}/shop/web`, repositoryPath: '/code/shop/web', projectPath: '/code/shop/web', isLinkedPlainFolder: false },
      folders: [folder(`${taskFolder}/shop/api`, { repositoryPath: '/code/shop/api' }), folder('/code/shop/notes', { state: 'plain' })],
      hasCodebase: true,
    })
    expect(rows.map((row) => [row.name, row.isIsolated])).toEqual([['web', true], ['api', true], ['notes', false]])
    expect(rows[1]).toMatchObject({ path: `${taskFolder}/shop/api`, repositoryPath: '/code/shop/api' })
  })

  test('the stand-in of a working folder with no repository says that its files are links', () => {
    const [row] = repositoryRows({
      working: { path: '/data/solus-task-folders/fix-1a2b3c4d/shop', repositoryPath: null, projectPath: '/code/shop', isLinkedPlainFolder: true },
      folders: [],
      hasCodebase: true,
    })
    expect(row).toMatchObject({ name: 'shop', state: 'plain', note: PLAIN_MEMBER_LINKS_NOTE })
  })

  test('a row shows the branch and the line counts of its own checkout', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/shop/api')], hasCodebase: true })
    const reading = repositoryRowReading(row!, gitState('fix-login', { insertions: 12, deletions: 3, fileCount: 2 }))
    expect(reading.badge).toBe('fix-login')
    expect(reading.diffStat).toMatchObject({ insertions: 12, deletions: 3 })
    // Before the host answers, the row shows no branch that it does not know.
    expect(repositoryRowReading(row!, undefined).badge).toBeUndefined()
    expect(repositoryRowReading(row!, gitState(null)).badge).toBe('Detached HEAD')
  })

  // The tooltip of a row is one line of text: a line break shows as a space, and two facts then read as one.
  test('the facts of the tooltip of a row show on one line, each apart from the next', () => {
    const [, row] = repositoryRows({ working, folders: [folder('/code/shop/api')], hasCodebase: true })
    const { tooltip } = repositoryRowReading(row!, gitState('fix-login', { insertions: 12, deletions: 3, fileCount: 2 }))
    expect(tooltip).not.toContain('\n')
    expect(tooltip.split(' · ')[0]).toBe('/code/shop/api')
    expect(tooltip.split(' · ').length).toBeGreaterThan(1)
    expect(tooltipDisplay(tooltip)).toEqual({ label: tooltip })
  })

  // The row that shows its Git rows is marked, and a screen reader hears its state.
  // A row that opens something else in place has no such state.
  test('only a folder with a repository has an open state, and one row is open at a time', () => {
    const rows = repositoryRows({
      working,
      folders: [folder('/code/libs/ui'), folder('/code/notes', { state: 'plain', source: 'attached' }), folder('/code/shop/api')],
      hasCodebase: true,
    })
    const [workingRow, ui, notes, api] = rows
    expect(rows.map((row) => repositoryRowExpanded(row, null))).toEqual([undefined, false, undefined, false])
    expect(repositoryRowExpanded(api!, api!.key)).toBe(true)
    expect(repositoryRowExpanded(ui!, api!.key)).toBe(false)
    // The working directory opens its changes and a plain folder opens its menu: the key of such a row opens nothing.
    expect(repositoryRowExpanded(workingRow!, workingRow!.key)).toBeUndefined()
    expect(repositoryRowExpanded(notes!, notes!.key)).toBeUndefined()
  })

  // "Add to the codebase" names the codebase. A label with no name cannot show: the action exists only with a codebase.
  test('each action of the row menu has a label, and "add to the codebase" names the codebase', () => {
    expect(repositoryActionLabel('open-files', null)).toBe('Open files')
    expect(repositoryActionLabel('detach', 'shop')).toBe('Detach from this session')
    expect(repositoryActionLabel('add-to-codebase', 'shop')).toBe('Add to shop')
    // The codebase was deleted while the menu was open: the menu shows no item for the action.
    expect(repositoryActionLabel('add-to-codebase', null)).toBeNull()
  })
})

describe('when the section shows', () => {
  test('for a session with a codebase or with a session folder, and for no other session', () => {
    expect(hasRepositoriesToShow('shop', 0)).toBe(true)
    expect(hasRepositoriesToShow(null, 1)).toBe(true)
    expect(hasRepositoriesToShow(null, 0)).toBe(false)
  })
})

describe('the folders of the codebase on other hosts', () => {
  const member: CodebaseMember = { path: '/srv/infra', name: 'infra', state: 'git', repositoryKey: null, rootPath: '/srv/infra', discovered: false, hasCommit: true, submodule: false }
  const groups: CodebaseHostMembers[] = [
    { installationId: 'install-laptop', serverId: 'laptop', label: 'Laptop', presence: 'ready', state: 'ready', isStale: false, error: null,
      roots: [{ root: { installationId: 'install-laptop', path: '/code/shop', name: 'shop' }, member: null, found: [], suggestions: [] }] },
    { installationId: 'install-build', serverId: 'build', label: 'Build server', presence: 'away', state: 'ready', isStale: true, error: null,
      roots: [{ root: { installationId: 'install-build', path: '/srv/infra', name: 'infra' }, member, found: [], suggestions: [] }] },
    { installationId: 'install-gone', serverId: null, label: null, presence: 'unknown', state: 'idle', isStale: false, error: null,
      roots: [{ root: { installationId: 'install-gone', path: '/old', name: 'old' }, member: null, found: [], suggestions: [] }] },
  ]
  const child = (id: string, runner: string): TreeAgentRow => ({
    key: `session:${id}`, kind: 'session', id, title: id, provider: 'codex', standing: 'live', mark: null, status: 'Running', detail: '',
    startedAt: 1, runStartedAt: 1, endedAt: null, serverId: runner, cwd: '/srv/infra', isRemote: true,
  })
  const subagent: TreeAgentRow = {
    key: 'subagent:1', kind: 'subagent', id: '1', title: 'Explore', provider: 'codex', standing: 'live', mark: null, status: 'Running', detail: '',
    startedAt: 1, runStartedAt: 1, endedAt: null, canStop: false,
  }

  test('lists each other host with its presence, its roots, and the child sessions that run there', () => {
    const hosts = otherHostFolders(groups, 'laptop', [child('infra-fix', 'runner-build'), child('local-child', 'runner-laptop'), subagent], (hostId) => hostId.replace('runner-', ''))
    expect(hosts.map((host) => [host.label, host.presenceNote, host.roots.map((root) => root.name), host.sessions.map((row) => row.id)])).toEqual([
      ['Build server', 'Offline', ['infra'], ['infra-fix']],
      ['Unknown host', 'Not connected', ['old'], []],
    ])
    expect(hosts[0]!.roots[0]!.state).toBe('git')
  })

  test('a child session shows its own branch and changes only when this client has read them', () => {
    expect(childRepositoryNote(undefined)).toBeNull()
    expect(childRepositoryNote(gitState('infra-fix', { insertions: 4, deletions: 0, fileCount: 1 }))).toBe('infra-fix · +4')
  })
})

describe('"Add repository" in a task folder session', () => {
  test('lists the candidates of the host by name', () => {
    const candidate = (path: string): CodebaseMember => ({ path, name: path.split('/').at(-1)!, state: 'git', repositoryKey: null, rootPath: '/code/shop', discovered: true, hasCommit: true, submodule: false })
    expect(candidateRows([candidate('/code/shop/web'), candidate('/code/shop/api')])).toEqual([
      { path: '/code/shop/api', name: 'api' },
      { path: '/code/shop/web', name: 'web' },
    ])
  })
})

// The section's reads. A `.svelte.ts` module is not compiled in a unit test,
// so the test supplies `$effect` and runs the effects itself.
const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void }
const previousEffect = runtime.$effect
afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
})

test('each repository row holds the details of its own checkout, and a hidden section holds none', () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  const update = () => {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
  }
  const state = { active: false, gitPathsKey: '/code/shop/web\n/code/shop/api', codebaseId: 'shop' as string | null, treeSessionId: null as string | null }
  const held = new Map<string, number>()
  const hold = (key: string) => { held.set(key, (held.get(key) ?? 0) + 1); return () => { held.set(key, held.get(key)! - 1) } }
  const holding = () => [...held].filter(([, count]) => count > 0).map(([key]) => key).sort()
  useRepositoryReads({
    get active() { return state.active },
    serverId: 'host',
    get gitPathsKey() { return state.gitPathsKey },
    get codebaseId() { return state.codebaseId },
    get treeSessionId() { return state.treeSessionId },
    environment: { watchDetails: (serverId, cwd) => hold(`details ${serverId} ${cwd}`) },
    codebases: { watch: () => hold('codebases'), watchMembers: (id) => hold(`members ${id}`) },
    sessionTree: { retain: (serverId, sessionId) => hold(`tree ${serverId} ${sessionId}`) },
  })
  update()
  expect(holding()).toEqual([])

  state.active = true
  update()
  expect(holding()).toEqual(['codebases', 'details host /code/shop/api', 'details host /code/shop/web', 'members shop'])

  // The child sessions are read only while a folder on another host shows.
  state.treeSessionId = 'session-1'
  state.gitPathsKey = '/code/shop/web'
  update()
  expect(holding()).toEqual(['codebases', 'details host /code/shop/web', 'members shop', 'tree host session-1'])

  state.active = false
  update()
  expect(holding()).toEqual([])
})
