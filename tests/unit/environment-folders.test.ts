import { afterEach, describe, expect, test } from 'bun:test'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers } from '@solus/workspace-ui/contexts/codebases/codebases.store.svelte'
import { useEnvironmentFolderReads } from '@solus/workspace-ui/components/project-panel/lib/environment-folder-reads.svelte'
import {
  ADD_FOLDER_LABEL,
  NO_SESSION_NOTE,
  OBSERVED_FOLDER_NOTE,
  PLAIN_FOLDER_NOTE,
  childRepositoryNote,
  environmentMenu,
  otherHostFolders,
  type EnvironmentMenu,
  type EnvironmentMenuInput,
  type OtherHostFolders,
} from '@solus/workspace-ui/components/project-panel/lib/environment-folders'
import type { TreeAgentRow } from '@solus/workspace-ui/components/project-panel/lib/rail-agents'

/**
 * The menu of the project row of the Environment card of the project panel
 * (docs/plans/codebases.md §9, "Running session"). The card names the work on
 * one row. The menu of that row has one section for each folder of the
 * session: the working folder, each session folder, and the folders of its
 * codebase on other hosts.
 */

function folder(path: string, patch: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...patch }
}

const child = (id: string, runner: string, cwd = '/srv/infra'): Extract<TreeAgentRow, { kind: 'session' }> => ({
  key: `session:${id}`, kind: 'session', id, title: id, provider: 'codex', standing: 'live', mark: null, status: 'Running', detail: '',
  startedAt: 1, runStartedAt: 1, endedAt: null, serverId: runner, cwd, isRemote: true,
})

function menuOf(folders: SessionFolder[], input: Partial<EnvironmentMenuInput> = {}): EnvironmentMenu {
  return environmentMenu({
    working: { path: '/code/shop', name: 'shop', state: 'git' },
    folders,
    otherHosts: [],
    host: { label: 'This Mac', isLocal: true },
    codebaseName: null,
    fileManagerName: 'Finder',
    canOpenTerminal: true,
    canAddFolder: true,
    ...input,
  })
}

const labelsOf = (menu: EnvironmentMenu) => menu.sections.map((section) => section.items.map((item) => item.label))
const headingsOf = (menu: EnvironmentMenu) => menu.sections.map(({ heading }) => [heading.name, heading.state])

describe('the menu of a session with one folder', () => {
  // WHY: a session with one project and no other folder must see the menu as it was before a session had more than one folder.
  test('has the two places that show the folder, no heading, and "Add folder…" last', () => {
    const menu = menuOf([])
    expect(menu.showsHeadings).toBe(false)
    expect(labelsOf(menu)).toEqual([['Open in Solus', 'Open in Finder']])
    expect(menu.addFolderLabel).toBe('Add folder…')
    expect(ADD_FOLDER_LABEL).toBe('Add folder…')
  })

  // The file manager opens on the screen of the host: the web client, and a session on a different machine, have none.
  test('a client that cannot open the file manager of the host has no item for it', () => {
    expect(labelsOf(menuOf([], { fileManagerName: null }))).toEqual([['Open in Solus']])
    expect(labelsOf(menuOf([], { fileManagerName: 'File Explorer' }))).toEqual([['Open in Solus', 'Open in File Explorer']])
  })

  // A guest, and a draft, cannot give the session a folder.
  test('a person who cannot change the session has no "Add folder…"', () => {
    expect(menuOf([], { canAddFolder: false }).addFolderLabel).toBeNull()
  })

  // An old list of the host can name the working directory: it is the working folder, not a second folder.
  test('a session folder at the working directory adds no section', () => {
    const menu = menuOf([folder('/code/shop/')])
    expect(menu.sections).toHaveLength(1)
    expect(menu.showsHeadings).toBe(false)
  })

  // The Git card has "Initialize Git" for a folder with no repository and nothing inside it.
  test('a working folder with no repository inside it has no "Track with Git" here', () => {
    expect(labelsOf(menuOf([], { working: { path: '/code/notes', name: 'notes', state: 'plain' } }))).toEqual([['Open in Solus', 'Open in Finder']])
  })

  // A draft has no session folders: its codebase says what the container holds.
  test('the draft of a container can track the container itself with Git', () => {
    const menu = menuOf([], {
      working: { path: '/code/shop', name: 'shop', state: 'plain' },
      draftMembers: [{ path: '/code/shop', state: 'plain' }, { path: '/code/shop/api', state: 'git' }, { path: '/code/shop/web', state: 'git' }],
      canAddFolder: false,
    })
    expect(labelsOf(menu)).toEqual([['Open in Solus', 'Open in Finder', 'Track with Git']])
    expect(menu.showsHeadings).toBe(false)
  })
})

describe('the menu of a session with two folders', () => {
  const menu = menuOf([folder('/code/solus-cloud')], { working: { path: '/code/solus', name: 'solus', state: 'git' }, codebaseName: 'solus + solus-cloud' })

  test('has one section for each folder, the working folder first, each with a heading', () => {
    expect(menu.showsHeadings).toBe(true)
    expect(menu.sections.map((section) => [section.place, section.path])).toEqual([['working', '/code/solus'], ['session', '/code/solus-cloud']])
    expect(headingsOf(menu)).toEqual([['solus', null], ['solus-cloud', null]])
  })

  // On this machine the host is a glyph, as on the project row.
  test('each heading has the mark of the host of the run', () => {
    expect(menu.sections.map(({ heading }) => [heading.hostLabel, heading.isLocalHost])).toEqual([['This Mac', true], ['This Mac', true]])
    const remote = menuOf([folder('/code/solus-cloud')], { host: { label: 'Build server', isLocal: false } })
    expect(remote.sections.map(({ heading }) => [heading.hostLabel, heading.isLocalHost])).toEqual([['Build server', false], ['Build server', false]])
  })

  // With more than one folder, each section has the same options: the working folder has its terminal here also.
  test('each section has the two places that show its folder, then the options of that folder', () => {
    expect(labelsOf(menu)).toEqual([
      ['Open in Solus', 'Open in Finder', 'Open terminal'],
      ['Open in Solus', 'Open in Finder', 'Open terminal'],
    ])
    expect(menu.addFolderLabel).toBe('Add folder…')
  })

  // The web client, and a session on a different machine, have no terminal and no file manager to open.
  test('a client with no terminal and no file manager on the host shows only the files pane', () => {
    const web = menuOf([folder('/code/solus-cloud')], { canOpenTerminal: false, fileManagerName: null })
    expect(labelsOf(web)).toEqual([['Open in Solus'], ['Open in Solus']])
  })

  test('each item has its own key, so one command of one folder runs one time', () => {
    const keys = menu.sections.flatMap((section) => section.items.map((item) => item.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the menu of a session with five folders', () => {
  const otherHosts: OtherHostFolders[] = [{
    installationId: 'install-build', serverId: 'build', label: 'Build server', isLocal: false, presence: 'away', presenceNote: 'Offline',
    roots: [{ path: '/srv/infra', name: 'infra', state: 'git' }],
    sessions: [child('infra-fix', 'build')],
  }]
  // A container: the session works in `shop`, and its repositories are session folders inside it.
  const menu = menuOf([
    folder('/code/shop/api'),
    folder('/Users/me/Desktop', { state: 'plain', source: 'attached' }),
    folder('/code/other', { source: 'observed', granted: false }),
  ], { working: { path: '/code/shop', name: 'shop', state: 'plain' }, otherHosts, codebaseName: 'shop' })

  test('the working folder is first, then each session folder in the order of the host, then the folders on other hosts', () => {
    expect(menu.sections.map((section) => section.place)).toEqual(['working', 'session', 'session', 'session', 'other-host'])
    expect(menu.showsHeadings).toBe(true)
  })

  test('each heading names its folder and says its state', () => {
    expect(headingsOf(menu)).toEqual([
      ['shop', 'No repository'],
      ['api', null],
      ['Desktop', 'No repository'],
      ['other', 'Not attached'],
      ['infra', 'Offline'],
    ])
    expect(menu.sections[4]!.heading).toMatchObject({ hostLabel: 'Build server', isLocalHost: false })
  })

  test('each section has the items of its folder, and "Add folder…" is the last item of the menu', () => {
    expect(labelsOf(menu)).toEqual([
      // The Git card lists the repositories of a container, so the way to make the container itself a repository is here.
      ['Open in Solus', 'Open in Finder', 'Open terminal', 'Track with Git'],
      // A repository of the codebase is a place: the host refuses to detach it.
      ['Open in Solus', 'Open in Finder', 'Open terminal'],
      ['Open in Solus', 'Open in Finder', 'Open terminal', 'Detach from this session', 'Add to shop', 'Track with Git'],
      ['Open in Solus', 'Open in Finder', 'Open terminal', 'Attach to this session', 'Add to shop'],
      // A session changes only the folders on its own host: a folder on a different host has the child sessions that work there.
      ['infra-fix'],
    ])
    expect(menu.addFolderLabel).toBe('Add folder…')
  })

  test('the tooltip of a heading has the path of its folder and what its state means', () => {
    expect(menu.sections[2]!.tooltip).toBe(`/Users/me/Desktop · ${PLAIN_FOLDER_NOTE}`)
    expect(menu.sections[3]!.tooltip).toContain(OBSERVED_FOLDER_NOTE)
  })
})

describe('the options of a session folder', () => {
  const optionsOf = (each: SessionFolder, input: Partial<EnvironmentMenuInput> = {}) =>
    labelsOf(menuOf([each], { canOpenTerminal: false, fileManagerName: null, ...input }))[1]!.slice(1)

  // WHY: an old rule attached the full `~/Desktop` of a person to a session. Detach must be reachable for it.
  test('an attached folder can be detached, also a folder with no repository in a session with no codebase', () => {
    expect(optionsOf(folder('/Users/me/Desktop', { state: 'plain', source: 'attached' }))).toEqual(['Detach from this session', 'Track with Git'])
  })

  test('an attached folder and a folder that a project tool made can be added to the codebase of the session', () => {
    for (const source of ['attached', 'created'] as const) {
      expect(optionsOf(folder('/code/tools', { source }), { codebaseName: 'shop + ui' })).toEqual(['Detach from this session', 'Add to shop + ui'])
    }
  })

  // "Add to the codebase" names the codebase. With no codebase, or after its delete, the menu has no item for it.
  test('a session with no codebase has no "Add to" item', () => {
    expect(optionsOf(folder('/code/tools', { source: 'attached' }))).toEqual(['Detach from this session'])
  })

  // The list of the host is read at a turn start. After "Add to codebase" the
  // folder is in the record at once, so the menu must not offer the action again.
  test('a folder that the codebase holds now is not offered again', () => {
    expect(optionsOf(folder('/code/tools', { source: 'attached' }), { codebaseName: 'shop', isInCodebase: (path) => path === '/code/tools' })).toEqual(['Detach from this session'])
  })

  // The agent was not given an observed folder: Solus only shows what a tool
  // changed there. The section says so and offers the way to give it.
  test('a folder that is not attached offers Attach, not Detach', () => {
    expect(optionsOf(folder('/code/other', { source: 'observed', granted: false }), { codebaseName: 'shop' })).toEqual(['Attach to this session', 'Add to shop'])
  })

  test('the worktree of a repository of the codebase in a task folder opens at the worktree', () => {
    const worktree = '/data/solus-task-folders/fix-1a2b3c4d/libs/ui'
    const section = menuOf([folder(worktree, { repositoryPath: '/code/libs/ui' })], { codebaseName: 'shop' }).sections[1]!
    expect(section).toMatchObject({ path: worktree, repositoryPath: '/code/libs/ui' })
    expect(section.heading.state).toBeNull()
    expect(section.tooltip).toContain('worktree of this session')
  })
})

describe('the sections of the folders on other hosts', () => {
  const host = (patch: Partial<OtherHostFolders>): OtherHostFolders => ({
    installationId: 'install-build', serverId: 'build', label: 'Build server', isLocal: false, presence: 'ready', presenceNote: null,
    roots: [{ path: '/srv/infra', name: 'infra', state: 'git' }], sessions: [], ...patch,
  })
  const sectionsOf = (patch: Partial<OtherHostFolders>) => menuOf([], { otherHosts: [host(patch)] }).sections.slice(1)

  // A section with no item would be a heading alone: it says why it has none.
  test('a folder that no child session works in says so', () => {
    const [section] = sectionsOf({})
    expect(section!.items).toEqual([])
    expect(section!.emptyNote).toBe(NO_SESSION_NOTE)
  })

  test('the heading says that the host is away, else the state of a folder that is no repository', () => {
    expect(sectionsOf({ presence: 'unknown', presenceNote: 'Not connected' })[0]!.heading.state).toBe('Not connected')
    expect(sectionsOf({ roots: [{ path: '/srv/notes', name: 'notes', state: 'plain' }] })[0]!.heading.state).toBe('No repository')
    expect(sectionsOf({ roots: [{ path: '/srv/gone', name: 'gone', state: 'missing' }] })[0]!.heading.state).toBe('Missing')
    // Before the host answers, the heading claims no state.
    expect(sectionsOf({ roots: [{ path: '/srv/infra', name: 'infra', state: null }] })[0]!.heading.state).toBeNull()
  })

  // A child session is an item of one section, so the menu shows it one time.
  test('a child session is in the section of the folder that holds its working directory, else in the first one of its host', () => {
    const sections = sectionsOf({
      roots: [{ path: '/srv/infra', name: 'infra', state: 'git' }, { path: '/srv/site', name: 'site', state: 'git' }],
      sessions: [child('site-fix', 'build', '/srv/site/app'), child('worktree-fix', 'build', '/data/worktrees/site-1a2b')],
    })
    expect(sections.map((section) => section.items.map((item) => item.label))).toEqual([['worktree-fix'], ['site-fix']])
    expect(sections.map((section) => section.emptyNote)).toEqual([null, null])
  })

  // A session on a different host can have a codebase with a folder on this machine.
  test('a folder on this machine has the glyph of this machine', () => {
    expect(sectionsOf({ isLocal: true, label: 'This Mac' })[0]!.heading).toMatchObject({ isLocalHost: true })
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

  test('says which of the other hosts is this machine', () => {
    const hosts = otherHostFolders(groups, 'laptop', [], (hostId) => hostId, (serverId) => serverId === 'build')
    expect(hosts.map((host) => host.isLocal)).toEqual([true, false])
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
