import { afterEach, describe, expect, test } from 'bun:test'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers } from '@solus/workspace-ui/contexts/codebases/codebases.store.svelte'
import { useEnvironmentFolderReads } from '@solus/workspace-ui/components/project-panel/lib/environment-folder-reads.svelte'
import {
  OBSERVED_FOLDER_NOTE,
  PLAIN_FOLDER_NOTE,
  childRepositoryNote,
  environmentFolderActionLabel,
  environmentFolderRows,
  environmentFolderTrailing,
  otherHostFolders,
} from '@solus/workspace-ui/components/project-panel/lib/environment-folders'
import type { TreeAgentRow } from '@solus/workspace-ui/components/project-panel/lib/rail-agents'

/**
 * The folders of the Environment card of the project panel
 * (docs/plans/codebases.md §9, "Running session"). The card shows where a
 * session works: its project, each session folder that is not a repository
 * of that project, and the folders of its codebase on other hosts.
 */

function folder(path: string, patch: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...patch }
}

const rowsOf = (folders: SessionFolder[], input: Partial<Parameters<typeof environmentFolderRows>[0]> = {}) =>
  environmentFolderRows({ workingPath: '/code/shop', folders, hasCodebase: false, ...input })

describe('the folder rows of the Environment card', () => {
  // WHY: a session with one project and no other folder must see the card as it was before codebases.
  test('a session with no session folder, and a repository of the project, give no row', () => {
    expect(rowsOf([])).toEqual([])
    // The project row names the project already. The Git card has the state of each repository inside it.
    expect(rowsOf([folder('/code/shop/api', { source: 'project' }), folder('/code/shop/web', { source: 'project' })])).toEqual([])
  })

  test('an attached folder, a member of the codebase outside the project, and a folder that was written are rows, in the order of the host', () => {
    const rows = rowsOf([
      folder('/code/libs/ui', { source: 'codebase' }),
      folder('/code/shop/api', { source: 'project' }),
      folder('/Users/me/Desktop', { state: 'plain', source: 'attached' }),
      folder('/code/other', { source: 'observed', granted: false }),
    ], { hasCodebase: true })
    expect(rows.map((row) => [row.name, row.mark])).toEqual([['ui', null], ['Desktop', 'No repository'], ['other', 'Not attached']])
  })

  // A repository of the codebase is in the Git card for its Git state. Here it is a place: its files and its terminal.
  test('a repository of the codebase has no action that changes the session', () => {
    const [row] = rowsOf([folder('/code/libs/ui', { source: 'codebase' })], { hasCodebase: true, canOpenTerminal: true })
    expect(row!.actions).toEqual(['open-files', 'open-terminal'])
    // The web client, and a session on a different machine, have no terminal to open.
    expect(rowsOf([folder('/code/libs/ui')])[0]!.actions).toEqual(['open-files'])
  })

  // WHY: an old rule attached the full `~/Desktop` of a person to a session. Detach must be reachable for it.
  test('an attached folder can be detached, also a folder with no repository in a session with no codebase', () => {
    const [row] = rowsOf([folder('/Users/me/Desktop', { state: 'plain', source: 'attached' })])
    expect(row!.actions).toEqual(['open-files', 'detach', 'track-with-git'])
    expect(row!.tooltip).toBe(`/Users/me/Desktop · ${PLAIN_FOLDER_NOTE}`)
  })

  test('an attached folder and a folder that a project tool made can be added to the codebase of the session', () => {
    for (const source of ['attached', 'created'] as const) {
      const [row] = rowsOf([folder('/code/tools', { source })], { hasCodebase: true })
      expect(row!.actions).toEqual(['open-files', 'detach', 'add-to-codebase'])
    }
  })

  // The list of the host is read at a turn start. After "Add to codebase" the
  // folder is in the record at once, so the row must not offer the action again.
  test('a folder that the codebase holds now is not offered again', () => {
    const [row] = rowsOf([folder('/code/tools', { source: 'attached' })], { hasCodebase: true, isInCodebase: (path) => path === '/code/tools' })
    expect(row!.actions).toEqual(['open-files', 'detach'])
  })

  // The agent was not given an observed folder: Solus only shows what a tool
  // changed there. The row says so and offers the way to give it.
  test('a folder that is not attached is marked and offers Attach, not Detach', () => {
    const [row] = rowsOf([folder('/code/other', { source: 'observed', granted: false })], { hasCodebase: true })
    expect(row!.mark).toBe('Not attached')
    expect(row!.actions).toEqual(['open-files', 'attach', 'add-to-codebase'])
    expect(row!.tooltip).toContain(OBSERVED_FOLDER_NOTE)
  })

  test('the worktree of a repository of the codebase in a task folder opens at the worktree', () => {
    const worktree = '/data/solus-task-folders/fix-1a2b3c4d/libs/ui'
    const [row] = rowsOf([folder(worktree, { repositoryPath: '/code/libs/ui' })], { hasCodebase: true })
    expect(row).toMatchObject({ path: worktree, repositoryPath: '/code/libs/ui', isIsolated: true, mark: null })
    expect(row!.tooltip).toContain('worktree of this session')
  })

  // "Add to the codebase" names the codebase. A label with no name cannot show: the action exists only with a codebase.
  test('each action of the row menu has a label, and "add to the codebase" names the codebase', () => {
    expect(environmentFolderActionLabel('open-files', null)).toBe('Open files')
    expect(environmentFolderActionLabel('open-terminal', null)).toBe('Open terminal')
    expect(environmentFolderActionLabel('attach', null)).toBe('Attach to this session')
    expect(environmentFolderActionLabel('detach', 'shop')).toBe('Detach from this session')
    expect(environmentFolderActionLabel('track-with-git', null)).toBe('Track with Git')
    expect(environmentFolderActionLabel('add-to-codebase', 'shop + ui')).toBe('Add to shop + ui')
    // The codebase was deleted while the menu was open: the menu shows no item for the action.
    expect(environmentFolderActionLabel('add-to-codebase', null)).toBeNull()
  })
})

describe('the trailing slot of a folder row', () => {
  // On this machine the host is a glyph, as on the project row.
  test('a repository of the work on this machine has no text, and on a different host it names the host', () => {
    expect(environmentFolderTrailing({ mark: null }, { label: 'This Mac', isLocal: true })).toEqual({ badge: undefined, badgePrefix: undefined })
    expect(environmentFolderTrailing({ mark: null }, { label: 'Build server', isLocal: false })).toEqual({ badge: 'Build server', badgePrefix: undefined })
  })

  // The mark stays when the rail is narrow. The host is the prefix, which the row cuts first.
  test('a folder with a state shows the state, and the host in front of it on a different host', () => {
    expect(environmentFolderTrailing({ mark: 'No repository' }, { label: 'This Mac', isLocal: true })).toEqual({ badge: 'No repository', badgePrefix: undefined })
    const remote = environmentFolderTrailing({ mark: 'Not attached' }, { label: 'Build server', isLocal: false })
    expect(remote.badge).toBe('Not attached')
    expect(remote.badgePrefix).toBe('Build server · ')
  })
})

function gitState(branch: string | null, lines?: { insertions: number; deletions: number; fileCount: number }): GitState {
  return {
    repoRoot: '/srv/infra', headSha: 'abc', branch, targetBranch: 'main', upstreamRef: null, aheadCount: 0, behindCount: 0,
    uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: 0, mergeInProgress: false },
    ...(lines ? { branchChanges: lines } : {}),
  } as GitState
}

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

// The reads of the rows. A `.svelte.ts` module is not compiled in a unit test,
// so the test supplies `$effect` and runs the effects itself.
const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void }
const previousEffect = runtime.$effect
afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
})

test('a session with a codebase reads its codebase, and its child sessions only while a folder on another host shows', () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  const update = () => {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
  }
  const state = { active: true, codebaseId: null as string | null, treeSessionId: null as string | null }
  const held = new Map<string, number>()
  const hold = (key: string) => { held.set(key, (held.get(key) ?? 0) + 1); return () => { held.set(key, held.get(key)! - 1) } }
  const holding = () => [...held].filter(([, count]) => count > 0).map(([key]) => key).sort()
  useEnvironmentFolderReads({
    get active() { return state.active },
    serverId: 'host',
    get codebaseId() { return state.codebaseId },
    get treeSessionId() { return state.treeSessionId },
    codebases: { watch: () => hold('codebases'), watchMembers: (id) => hold(`members ${id}`) },
    sessionTree: { retain: (serverId, sessionId) => hold(`tree ${serverId} ${sessionId}`) },
  })
  // A session with no codebase reads nothing: its card is the card of each session with one project.
  update()
  expect(holding()).toEqual([])

  state.codebaseId = 'shop'
  update()
  expect(holding()).toEqual(['codebases', 'members shop'])

  state.treeSessionId = 'session-1'
  update()
  expect(holding()).toEqual(['codebases', 'members shop', 'tree host session-1'])

  state.active = false
  update()
  expect(holding()).toEqual([])
})
