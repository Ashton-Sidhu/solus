import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Codebase, CodebaseFolderScan, CodebaseMember } from '@solus/contracts/codebases'
import type { CodebaseHost, CodebaseHostMembers } from '@solus/workspace-ui/contexts/codebases/codebases.store.svelte'
import { ROUTES } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'
import { codebasesSearchWords } from '../../packages/workspace-ui/src/components/settings/lib/settings-search-data'
import { wordsMatch } from '../../packages/workspace-ui/src/components/settings/lib/settings-search'
import { settingsSectionLoaders } from '../../packages/workspace-ui/src/components/settings/lib/settings-section-loaders'
import {
  CODEBASE_NAMING_OPTIONS,
  codebaseSummary,
  hostMembersNote,
  memberPlace,
  NEW_CODEBASE,
  newCodebaseDraft,
  rootDescription,
  rootName,
  scanSummary,
  UNKNOWN_HOST_LABEL,
} from '../../packages/workspace-ui/src/components/codebases/lib/codebase-view'

/** Settings → Codebases (docs/plans/codebases.md §9): the tab, its entry points, and the text of its states. */

// The page requests are rune modules. The test runs them as plain values.
const previousState = (globalThis as unknown as { $state?: unknown }).$state
let codebaseCommands: typeof import('../../packages/workspace-ui/src/components/settings/lib/settings-commands')['codebaseCommands']
let codebasesPageRequest: typeof import('../../packages/workspace-ui/src/components/codebases/lib/codebases-page-request.svelte')['codebasesPageRequest']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ codebaseCommands } = await import('../../packages/workspace-ui/src/components/settings/lib/settings-commands'))
  ;({ codebasesPageRequest } = await import('../../packages/workspace-ui/src/components/codebases/lib/codebases-page-request.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const SETTINGS_PAGE = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/settings/SettingsPage.svelte'), 'utf8')

describe('the Codebases settings tab', () => {
  // WHY: a tab is reachable only when the route accepts it, the nav lists it,
  // and the section loader has it. One missing entry gives a blank page.
  test('is a route, a page in the Code group, and a lazy section', () => {
    expect(ROUTES.settings.parse('codebases')).toEqual({ tab: 'codebases' })
    const entry = /\{\s*id: "codebases",[^}]*\}/.exec(SETTINGS_PAGE)?.[0] ?? ''
    expect(entry).toContain('label: "Codebases"')
    expect(entry).toContain('group: "Code"')
    expect(typeof settingsSectionLoaders.codebases).toBe('function')
  })

  // WHY: the open codebase is the page URL, so a link opens the same codebase,
  // and a move to a different tab does not carry it as a project scope.
  test('keeps the open codebase in the route, apart from the project scope', () => {
    expect(ROUTES.settings.parse('codebases/abc-123')).toEqual({ tab: 'codebases', codebase: 'abc-123' })
    expect(ROUTES.settings.serialize({ tab: 'codebases', codebase: NEW_CODEBASE })).toBe('codebases/new')
    expect(ROUTES.settings.parse('codebases/abc-123')).not.toHaveProperty('projectCwd')
  })

  test('is found by settings search from words a person uses for it', () => {
    expect(SETTINGS_PAGE).toContain('codebases: codebasesSearch')
    for (const query of ['codebase', 'repositories', 'multi-repo', 'folders']) {
      expect(wordsMatch(query, ['Codebases', ...codebasesSearchWords])).toBe(true)
    }
    expect(wordsMatch('webhook', ['Codebases', ...codebasesSearchWords])).toBe(false)
  })

  test('the command palette opens the page, and New codebase asks for the form one time', () => {
    const opened: string[] = []
    const commands = codebaseCommands({ showSettings: (tab) => { opened.push(tab) } })
    void commands.find((command) => command.id === 'open-codebases')!.run()
    expect(opened).toEqual(['codebases'])
    expect(codebasesPageRequest.isNewAsked).toBe(false)

    void commands.find((command) => command.id === 'new-codebase')!.run()
    expect(opened).toEqual(['codebases', 'codebases'])
    expect(codebasesPageRequest.takeNew()).toBe(true)
    expect(codebasesPageRequest.takeNew()).toBe(false)
  })
})

describe('the text of the Codebases page', () => {
  const host: CodebaseHost = { serverId: 'local', installationId: 'inst-mac', label: 'This computer', isReady: true, status: 'ready' }
  const hostOf = (installationId: string) => (installationId === 'inst-mac' ? host : null)

  function group(patch: Partial<CodebaseHostMembers>): CodebaseHostMembers {
    return { installationId: 'inst-build', serverId: 'build', label: 'build-server', presence: 'ready', state: 'ready', isStale: false, error: null, roots: [], ...patch }
  }

  // WHY: a root on a host that this client does not know is still part of the
  // codebase. The list must count it and name it, not hide it.
  test('a codebase names each host it covers, and a host that is not on this device', () => {
    const codebase: Codebase = {
      id: 'shop', name: 'Shop', updatedAt: 1, deletedAt: null,
      roots: [
        { installationId: 'inst-mac', path: '/code/shop', name: 'shop' },
        { installationId: 'inst-mac', path: '/code/libs', name: 'libs' },
        { installationId: 'inst-elsewhere', path: '/srv/infra', name: 'infra' },
      ],
    }
    expect(codebaseSummary(codebase, hostOf)).toBe(`3 folders · This computer · ${UNKNOWN_HOST_LABEL}`)
    expect(codebaseSummary({ ...codebase, roots: [] }, hostOf)).toBe('No folders')
  })

  // WHY: old members shown as current, or a spinner that never ends, is a
  // correctness defect. Each state of a host has its own text.
  test('each state of a host has its own note', () => {
    expect(hostMembersNote(group({}))).toBeNull()
    expect(hostMembersNote(group({ state: 'loading' }))).toMatchObject({ isBusy: true, text: 'Reading the folders on build-server…' })
    expect(hostMembersNote(group({ presence: 'unknown', serverId: null, label: null, state: 'idle' }))).toMatchObject({ isBusy: false, tone: 'warning' })
    expect(hostMembersNote(group({ presence: 'away', isStale: true }))?.text).toBe('build-server is not connected. These are the folders it found the last time it answered.')
    expect(hostMembersNote(group({ presence: 'away', state: 'idle' }))?.text).toBe('build-server is not connected. Its folders are read when it connects.')
    expect(hostMembersNote(group({ state: 'error', error: 'The disk did not answer.', isStale: true }))).toMatchObject({
      tone: 'error',
      text: 'build-server could not read its folders: The disk did not answer. This is its last answer.',
    })
  })

  // WHY: a folder row must say what the codebase gets from it. A Git root is
  // itself the repository, so "no repository inside" would read as empty.
  test('a folder row says what the folder is and what is inside it', () => {
    expect(rootDescription('git', 0)).toBe('Git repository')
    expect(rootDescription('git', 2)).toBe('Git repository · 2 repositories inside')
    expect(rootDescription('plain', 0)).toBe('Folder · No repository inside')
    expect(rootDescription('plain', 1)).toBe('Folder · 1 repository inside')
    expect(rootDescription('missing', 0)).toBe('Not on the host')
  })

  // WHY: a root saved with no name must still show a name, not an empty row.
  test('a folder with no saved name is named by its path', () => {
    expect(rootName({ name: '', path: '/Users/me/solus' })).toBe('solus')
    expect(rootName({ name: 'Shop', path: '/code/shop' })).toBe('Shop')
  })

  test('a scan says what the folder is and how many repositories are inside it', () => {
    const found = (path: string): CodebaseMember => ({ path, name: '', state: 'git', repositoryKey: null, rootPath: '/code/shop', discovered: true, hasCommit: true, submodule: false })
    const scan: CodebaseFolderScan = { path: '/code/shop', state: 'plain', members: [{ ...found('/code/shop'), discovered: false, state: 'plain' }, found('/code/shop/api'), found('/code/shop/packages/web')], suggestions: [] }
    expect(scanSummary(scan)).toBe('A folder with no repository of its own. 2 repositories were found inside it.')
    expect(scanSummary({ ...scan, state: 'git', members: scan.members.slice(0, 1) })).toBe('A Git repository. No repository was found inside it.')
    expect(scanSummary({ ...scan, state: 'missing', members: [] })).toBe('This folder does not exist on the host.')
    expect(memberPlace(found('/code/shop/packages/web'))).toBe('packages/web')
  })
})

describe('the form of a new codebase', () => {
  // docs/plans/codebases.md decision 14: a person chooses one container folder, or two folders.
  const found = (path: string): CodebaseMember => ({ path, name: '', state: 'git', repositoryKey: null, rootPath: '/code/shop', discovered: true, hasCommit: true, submodule: false })
  const folder = (path: string, state: 'git' | 'plain', inside: string[]): CodebaseFolderScan => ({
    path, state, suggestions: [],
    members: [{ ...found(path), discovered: false, state, rootPath: path }, ...inside.map((name) => ({ ...found(`${path}/${name}`), rootPath: path }))],
  })

  test('one folder that holds two or more repositories makes a codebase, with the name of the folder when none is typed', () => {
    const container = folder('/code/shop', 'plain', ['api', 'web'])
    expect(newCodebaseDraft('', container, false)).toEqual({ name: 'shop', firstIsContainer: true, canCreate: true })
    expect(newCodebaseDraft('  Storefront ', container, false)).toMatchObject({ name: 'Storefront', canCreate: true })
    // With a second folder the codebase is more than the container: the person names it.
    expect(newCodebaseDraft('', container, true)).toMatchObject({ name: '', canCreate: false })
  })

  test('one folder that is a project needs a second folder', () => {
    // WHY: a repository, and a folder that holds one repository or none, are projects. One project is no codebase.
    for (const project of [folder('/code/api', 'git', []), folder('/code/api', 'git', ['a', 'b']), folder('/code/one', 'plain', ['api']), folder('/code/notes', 'plain', [])]) {
      expect(newCodebaseDraft('Work', project, false)).toMatchObject({ firstIsContainer: false, canCreate: false })
      expect(newCodebaseDraft('Work', project, true)).toMatchObject({ canCreate: true })
    }
    expect(newCodebaseDraft('Work', null, false).canCreate).toBe(false)
  })

  test('the naming setting has the two ways that a host knows, the generated one first', () => {
    // WHY: the host reads these values from the setting of the person and from `.solus/config.json`.
    expect(CODEBASE_NAMING_OPTIONS.map((option) => option.value)).toEqual(['generated', 'folders'])
  })
})

