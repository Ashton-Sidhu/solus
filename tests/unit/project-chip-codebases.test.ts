import { codebaseMark } from '@solus/contracts/codebase-badge'
import { afterEach, describe, expect, test } from 'bun:test'
import type { Codebase } from '@solus/contracts/codebases'
import type { RunConfig, RunLocation } from '@solus/contracts/types'
import {
  NO_FOLDER_ON_CLIENT_NOTE,
  NO_FOLDER_ON_HOST_NOTE,
  automaticCodebase,
  chipAtRest,
  chipHint,
  codebaseChipOptions,
  codebaseChoiceStep,
  codebaseTooltip,
  marksProjectRow,
  type CodebaseChipHost,
} from '@solus/workspace-ui/components/input/lib/codebase-choice'
import { CodebaseDecisions, aimRunAtCodebase } from '@solus/workspace-ui/components/input/lib/project-selection'
import { useCodebaseStart } from '@solus/workspace-ui/components/input/lib/codebase-start.svelte'
import { codebaseOf, checkoutPlace, chooseCodebase, folderLocation, inheritedLocation, openFolder, refusesCodebase, runHost } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * The codebases of the project chip (docs/plans/codebases.md §9, "Start").
 * The chip has one choice: a run is in a project, or it is in a codebase. A
 * person must never read two names, or see two marked rows, for one place. A
 * project is one folder or one repository, and a codebase is two or more
 * projects or one container, so a project is never also a codebase. A root
 * names its host by an installation id; the chip opens a root on a host of
 * this client.
 */

const HOSTS: Record<string, CodebaseChipHost> = {
  'install-laptop': { serverId: 'laptop', label: 'Laptop', isReady: true },
  'install-build': { serverId: 'build', label: 'Build server', isReady: true },
}
const hostOf = (installationId: string) => HOSTS[installationId] ?? null

function codebase(id: string, roots: [installationId: string, path: string][]): Codebase {
  return { id, name: id, roots: roots.map(([installationId, path]) => ({ installationId, path, name: path.split('/').at(-1)! })), updatedAt: 1, deletedAt: null }
}

const shop = codebase('shop', [['install-laptop', '/code/shop'], ['install-laptop', '/code/ui']])
const platform = codebase('platform', [['install-laptop', '/code/shop/api'], ['install-laptop', '/code/libs'], ['install-build', '/srv/infra']])
const infra = codebase('infra', [['install-build', '/srv/infra'], ['install-build', '/srv/tools']])
const lost = codebase('lost', [['install-unknown', '/somewhere'], ['install-unknown', '/elsewhere']])
/** A container: one root, `/code/store`, that holds the repositories `api` and `web`. */
const store: Codebase = { id: 'store', name: 'store', roots: [{ installationId: 'install-laptop', path: '/code/store', name: 'store', container: true }], updatedAt: 1, deletedAt: null }

describe('the Codebases group of the project chip', () => {
  const run = { serverId: 'laptop', projectPath: '/code/other', codebaseId: null }

  test('lists each codebase, and a choice opens its first folder on the run host', () => {
    const [option] = codebaseChipOptions([shop], run, hostOf)
    expect(option).toMatchObject({ id: 'shop', isCurrent: false, note: null })
    expect(codebaseChoiceStep(option!)).toEqual({ kind: 'open', root: { serverId: 'laptop', path: '/code/shop', name: 'shop', container: false } })
  })

  // The list has no second step for the folders of a codebase: a row of the
  // Projects group is how a person changes the working folder inside a codebase.
  test('a codebase with several folders on the run host opens the first one, with no second step', () => {
    const [option] = codebaseChipOptions([platform], run, hostOf)
    expect(codebaseChoiceStep(option!)).toEqual({ kind: 'open', root: { serverId: 'laptop', path: '/code/shop/api', name: 'api', container: false } })
  })

  // A session changes only the folders on its run host, so a codebase with no
  // folder there cannot start here: the person moves the run to a host that has one.
  test('a codebase with no folder on the run host says so and offers the hosts that have one', () => {
    const [option] = codebaseChipOptions([infra], run, hostOf)
    expect(option!.note).toBe(NO_FOLDER_ON_HOST_NOTE)
    const step = codebaseChoiceStep(option!)
    expect(step.kind === 'hosts' && step.hosts).toEqual([
      { serverId: 'build', label: 'Build server', isReady: true, roots: [{ serverId: 'build', path: '/srv/infra', name: 'infra', container: false }, { serverId: 'build', path: '/srv/tools', name: 'tools', container: false }] },
    ])
  })

  test('a codebase whose folders are all on hosts this client does not know cannot be chosen', () => {
    const [option] = codebaseChipOptions([lost], run, hostOf)
    expect(option!.note).toBe(NO_FOLDER_ON_CLIENT_NOTE)
    expect(codebaseChoiceStep(option!)).toEqual({ kind: 'none' })
  })

  // The chip offers the choice for a folder that two codebases hold: the
  // person chose that folder, so a choice must not move the run to a root.
  test('a codebase that holds the project folder keeps the folder', () => {
    const inApi = { serverId: 'laptop', projectPath: '/code/shop/api', codebaseId: null }
    const options = codebaseChipOptions([shop, platform], inApi, hostOf)
    expect(options.map((option) => codebaseChoiceStep(option).kind)).toEqual(['keep', 'keep'])
  })

  test('marks the codebase the run starts with', () => {
    const options = codebaseChipOptions([shop, platform], { ...run, codebaseId: 'platform' }, hostOf)
    expect(options.map((option) => option.isCurrent)).toEqual([false, true])
  })

  // The maintainers removed each count from the list: a row is the favicons of the folders and the name.
  test('a row has no count: its note says only that the run host has no folder', () => {
    const repositoriesIn = () => ['/code/shop/api', '/code/shop/web']
    const options = codebaseChipOptions([shop, platform, store, infra, lost], run, hostOf, repositoriesIn)
    expect(options.map((option) => option.note)).toEqual([null, null, null, NO_FOLDER_ON_HOST_NOTE, NO_FOLDER_ON_CLIENT_NOTE])
  })

  // WHY: the picker and the session sidebar show one mark for one codebase, so a person matches them at a glance.
  test('a row shows the badge of the codebase, the same mark as its sessions in the sidebar', () => {
    const [ofShop] = codebaseChipOptions([{ ...shop, badge: { color: 'teal', icon: { kind: 'emoji', emoji: '🛒' } } }], run, hostOf)
    expect(ofShop!.mark).toEqual(codebaseMark({ name: shop.name, badge: { color: 'teal', icon: { kind: 'emoji', emoji: '🛒' } } }))
    expect(codebaseChipOptions([platform], run, hostOf)[0]!.mark).toEqual(codebaseMark(platform))
  })

  test('a container codebase lists its repositories, and its own folder until its host read them', () => {
    const read = codebaseChipOptions([store], run, hostOf, (id, root) => (id === 'store' && root.path === '/code/store' ? ['/code/store/api', '/code/store/web'] : null))[0]!
    expect(read.folders.map((folder) => folder.name)).toEqual(['api', 'web'])
    const notRead = codebaseChipOptions([store], run, hostOf)[0]!
    expect(notRead.folders.map((folder) => folder.name)).toEqual(['store'])
    // The host is asked only about a container root: a root that is a project has nothing inside it to show.
    const asked: string[] = []
    codebaseChipOptions([shop, store], run, hostOf, (_id, root) => { asked.push(root.path); return null })
    expect(asked).toEqual(['/code/store'])
  })

  test('the tooltip has the details: the name, then each folder with its host', () => {
    const [ofPlatform, ofLost] = codebaseChipOptions([platform, lost], run, hostOf)
    expect(codebaseTooltip(ofPlatform!)).toEqual({
      name: 'platform',
      folders: [{ name: 'api', host: 'Laptop' }, { name: 'libs', host: 'Laptop' }, { name: 'infra', host: 'Build server' }],
      more: 0,
    })
    // A host that this client does not know has no name here: the tooltip says so.
    expect(codebaseTooltip(ofLost!).folders).toEqual([{ name: 'somewhere', host: null }, { name: 'elsewhere', host: null }])
    const read = codebaseChipOptions([store], run, hostOf, () => ['/code/store/api', '/code/store/web'])[0]!
    expect(codebaseTooltip(read)).toEqual({ name: 'store', folders: [{ name: 'api', host: 'Laptop' }, { name: 'web', host: 'Laptop' }], more: 0 })
  })

  test('a tooltip of a codebase with many folders names eight, then the count of the others', () => {
    const many = codebase('many', Array.from({ length: 11 }, (_, n): [string, string] => ['install-laptop', `/code/p${n}`]))
    const details = codebaseTooltip(codebaseChipOptions([many], run, hostOf)[0]!)
    expect(details.folders).toHaveLength(8)
    expect(details.more).toBe(3)
  })
})

describe('a container codebase in the list', () => {
  // docs/plans/codebases.md decision 14: a session of a container works in the container folder,
  // so that a path between two of its repositories works.
  test('a choice opens the container folder', () => {
    const elsewhere = codebaseChipOptions([store], { serverId: 'laptop', projectPath: '/code/other', codebaseId: null }, hostOf)[0]!
    expect(codebaseChoiceStep(elsewhere)).toEqual({ kind: 'open', root: { serverId: 'laptop', path: '/code/store', name: 'store', container: true } })
  })

  test('a run in one repository of the container moves to the container folder, and a run in that folder stays', () => {
    const inApi = codebaseChipOptions([store], { serverId: 'laptop', projectPath: '/code/store/api', codebaseId: 'store' }, hostOf)[0]!
    expect(inApi.holdsProject).toBe(true)
    expect(codebaseChoiceStep(inApi)).toMatchObject({ kind: 'open', root: { path: '/code/store' } })
    const inStore = codebaseChipOptions([store], { serverId: 'laptop', projectPath: '/code/store', codebaseId: 'store' }, hostOf)[0]!
    expect(codebaseChoiceStep(inStore)).toEqual({ kind: 'keep' })
  })

  test('the chip of a draft in the container shows the codebase, with no project name beside it', () => {
    expect(chipAtRest('store', store, { holding: [store] })).toEqual({ kind: 'codebase', name: 'store', note: null })
  })
})

describe('"No codebase" on a run', () => {
  const workspaceFor = (state: { run: RunConfig }) => ({
    runFor: () => state.run,
    defaultRunConfig: state.run,
    moveRun: (_sourceId: string, next: RunLocation) => { state.run = { ...state.run, location: next } },
    config: { setBaseDirectory: async () => {} },
  })

  // The host gives a session with no codebase the codebase of its folder, or makes one.
  // "No codebase" must reach the host, or the choice of the person is undone at Send.
  test('tells the host to make none and to take none', async () => {
    const state = { run: runAt('/code/store') }
    await aimRunAtCodebase(workspaceFor(state) as never, { refresh: async () => true }, 'draft-1', { codebaseId: null }, new CodebaseDecisions())
    expect(refusesCodebase(state.run)).toBe(true)
    expect(state.run.location.noCodebase).toBe(true)
  })

  // "No codebase" is the one way to a project-only run in a folder that a codebase holds.
  test('on a codebase run, clears the codebase, tells the host to form none, and the chip shows the project', async () => {
    const state = { run: runAt('/code/shop', 'shop') }
    expect(chipAtRest('shop', shop, { holding: [shop] }).kind).toBe('codebase')
    await aimRunAtCodebase(workspaceFor(state) as never, { refresh: async () => true }, 'draft-1', { codebaseId: null }, new CodebaseDecisions())
    expect(codebaseOf(state.run)).toBeNull()
    expect(state.run.location.noCodebase).toBe(true)
    // The run has no codebase, so the chip has no record to show.
    expect(chipAtRest('shop', undefined, { holding: [shop], refuses: refusesCodebase(state.run) })).toEqual({ kind: 'project', name: 'shop', note: null })
  })

  test('a run that gets a codebase refuses none, and the choice follows the project home', async () => {
    const state = { run: runAt('/code/shop', 'shop') }
    await aimRunAtCodebase(workspaceFor(state) as never, { refresh: async () => true }, 'draft-1', { codebaseId: null }, new CodebaseDecisions())
    expect(codebaseOf(state.run)).toBeNull()
    const refused = state.run.location
    // A new session from this one is the same work: it also has none.
    expect(inheritedLocation(refused).noCodebase).toBe(true)
    // A different project home is different work: the host decides again there.
    expect(openFolder(refused, { serverId: 'laptop', path: '/code/other' }).noCodebase).toBeUndefined()
    // The host or the person names a codebase: the run has it, and refuses none.
    const chosen = chooseCodebase(refused, 'shop')
    expect(chosen).toMatchObject({ codebaseId: 'shop' })
    expect('noCodebase' in chosen).toBe(false)
  })
})

describe('the automatic codebase of a project folder', () => {
  test('a folder in exactly one codebase gets it with no step', () => {
    expect(automaticCodebase(null, [shop])).toBe('shop')
  })

  test('a folder in two codebases gets none, and the chip asks the person beside the project', () => {
    expect(automaticCodebase(null, [shop, platform])).toBeNull()
    expect(chipAtRest('api', undefined, { holding: [shop, platform] })).toEqual({ kind: 'project', name: 'api', note: 'Choose codebase' })
    // The person answered "No codebase": the chip asks no more.
    expect(chipAtRest('api', undefined, { holding: [shop, platform], refuses: true })).toEqual({ kind: 'project', name: 'api', note: null })
  })

  test('a folder in no codebase is not decided, and the chip shows the project', () => {
    // WHY: the host forms the codebase of a container when a person opens the folder. Its record can arrive
    // after the draft is there, and it must then apply.
    expect(automaticCodebase(null, [])).toBeUndefined()
    expect(chipAtRest('other', undefined, { holding: [] })).toEqual({ kind: 'project', name: 'other', note: null })
  })

  test('a run that has a codebase keeps it', () => {
    expect(automaticCodebase('platform', [shop])).toBeNull()
  })

  test('nothing is decided before the host answers its codebases', () => {
    expect(automaticCodebase(null, null)).toBeUndefined()
  })
})

describe('the one choice of the project chip', () => {
  const PROJECT_ROWS = ['laptop:/code/shop', 'laptop:/code/other', 'laptop:/code/store']
  /** Each marked row of the list: the rows of the Projects group, then the rows of the Codebases group. */
  function marked(chip: ReturnType<typeof chipAtRest>, currentProjectKey: string, codebaseId: string | null): string[] {
    const options = codebaseChipOptions([shop, platform], { serverId: 'laptop', projectPath: '/code/shop', codebaseId }, hostOf)
    return [
      ...PROJECT_ROWS.filter((key) => marksProjectRow(chip, key, currentProjectKey)).map((key) => `project ${key}`),
      ...options.filter((option) => option.isCurrent).map((option) => `codebase ${option.id}`),
    ]
  }

  // The chip showed "shop platform" before: two names for one place.
  test('a run that has a codebase shows the codebase: one name, and one marked row in the Codebases group', () => {
    const chip = chipAtRest('shop', platform, { holding: [shop, platform] })
    expect(chip).toEqual({ kind: 'codebase', name: 'platform', note: null })
    expect(marked(chip, 'laptop:/code/shop', 'platform')).toEqual(['codebase platform'])
  })

  // A person can give a codebase the name of a project. The chip read "shop shop", and then "shop 2 repositories".
  test('a codebase with the name of the project shows that name one time', () => {
    const chip = chipAtRest('shop', shop, { holding: [shop] })
    expect(chip).toEqual({ kind: 'codebase', name: 'shop', note: null })
    expect(marked(chip, 'laptop:/code/shop', 'shop')).toEqual(['codebase shop'])
  })

  test('a run with no codebase shows the project: one name, and one marked row in the Projects group', () => {
    const chip = chipAtRest('other', undefined, { holding: [] })
    expect(chip).toEqual({ kind: 'project', name: 'other', note: null })
    expect(marked(chip, 'laptop:/code/other', null)).toEqual(['project laptop:/code/other'])
  })

  // The record of the codebase is on a host that this client did not read: the client has no name for it.
  test('a run whose codebase this client has no record of shows its project', () => {
    const chip = chipAtRest('shop', undefined)
    expect(chip.kind).toBe('project')
    expect(marked(chip, 'laptop:/code/shop', 'unknown')).toEqual(['project laptop:/code/shop'])
  })

  // The chip of a codebase run does not show the working folder: the tooltip does.
  test('the tooltip of a codebase run says where the run works', () => {
    expect(chipHint(chipAtRest('api', platform), { folder: 'api', host: 'Laptop' })).toBe('Works in api on Laptop.')
    expect(chipHint(chipAtRest('other', undefined), { folder: 'other', host: 'Laptop' })).toBeNull()
  })
})

// The strip's effects. A `.svelte.ts` module is not compiled in a unit test,
// so the test supplies `$effect` and runs the effects itself.
const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void }
const previousEffect = runtime.$effect
afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
})

function runAt(path: string, codebaseId: string | null = null): RunConfig {
  return { location: folderLocation({ serverId: 'laptop', path }, { codebaseId }) } as RunConfig
}

function strip(initial: RunConfig, holding: () => Codebase[], hostStatus: () => 'ready' | 'loading' = () => 'ready') {
  const effects: Array<() => void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  const state = { run: initial, isStarted: false, needsBaseBranch: false, opened: 0, memberWatches: [] as string[], deleted: [] as string[] }
  const decisions = new CodebaseDecisions()
  useCodebaseStart({
    sourceId: 'draft-1',
    get run() { return state.run },
    get isStarted() { return state.isStarted },
    store: {
      get hosts() { return [{ serverId: 'laptop', status: hostStatus() }] },
      watch: () => () => {},
      watchMembers: (codebaseId) => { state.memberWatches.push(codebaseId); return () => {} },
      isDeleted: (codebaseId) => state.deleted.includes(codebaseId),
      codebasesOfFolder: () => holding(),
    },
    decisions,
    applyLocation: (next: RunLocation) => { state.run = { ...state.run, location: next } },
    get needsBaseBranch() { return state.needsBaseBranch },
    openStartControl: () => { state.opened++ },
  })
  return { state, decisions, update: () => { for (const effect of effects) effect() } }
}

describe('the codebase of a run that the strip shows', () => {
  test('a folder in exactly one codebase starts with it, and its members are then read', () => {
    const { state, update } = strip(runAt('/code/shop'), () => [shop])
    update()
    expect(codebaseOf(state.run)).toBe('shop')
    update()
    expect(state.memberWatches).toEqual(['shop'])
  })

  test('a folder in two codebases starts with none', () => {
    const { state, update } = strip(runAt('/code/shop/api'), () => [shop, platform])
    update()
    expect(codebaseOf(state.run)).toBeNull()
  })

  // "No codebase" is the person's choice for that folder. A later look at the
  // same folder must not put the codebase back.
  test('"No codebase" stays for the folder, and a different folder is decided again', async () => {
    const { state, decisions, update } = strip(runAt('/code/shop'), () => [shop])
    update()
    expect(codebaseOf(state.run)).toBe('shop')
    const workspace = {
      runFor: () => state.run,
      defaultRunConfig: state.run,
      moveRun: (_sourceId: string, next: RunLocation) => { state.run = { ...state.run, location: next } },
      config: { setBaseDirectory: async () => {} },
    }
    await aimRunAtCodebase(workspace as never, { refresh: async () => true }, 'draft-1', { codebaseId: null }, decisions)
    update()
    expect(codebaseOf(state.run)).toBeNull()

    state.run = runAt('/code/libs')
    update()
    expect(codebaseOf(state.run)).toBe('shop')
  })

  // A row of the Projects group is how a person changes the working folder inside a codebase.
  // A different project home clears the codebase, and the one codebase that holds the new folder comes back.
  test('a project choice inside a codebase moves the working folder, and the chip shows the codebase', () => {
    const { state, update } = strip(runAt('/code/shop', 'shop'), () => [shop])
    state.run = { ...state.run, location: openFolder(state.run.location, { serverId: 'laptop', path: '/code/shop/api' }) }
    expect(codebaseOf(state.run)).toBeNull()
    update()
    expect(codebaseOf(state.run)).toBe('shop')
    expect(checkoutPlace(state.run).path).toBe('/code/shop/api')
    expect(chipAtRest('api', shop, { holding: [shop] })).toEqual({ kind: 'codebase', name: 'shop', note: null })
  })

  // The host forms the codebase of a container when a person opens the folder. The record arrives after the draft.
  test('a codebase that forms for the folder after the draft is there applies, with no step', () => {
    let holding: Codebase[] = []
    const { state, update } = strip(runAt('/code/store'), () => holding)
    update()
    expect(codebaseOf(state.run)).toBeNull()
    holding = [store]
    update()
    expect(codebaseOf(state.run)).toBe('store')
  })

  test('waits for the host to answer its codebases', () => {
    let status: 'ready' | 'loading' = 'loading'
    const { state, update } = strip(runAt('/code/shop'), () => [shop], () => status)
    update()
    expect(codebaseOf(state.run)).toBeNull()
    status = 'ready'
    update()
    expect(codebaseOf(state.run)).toBe('shop')
  })

  // The host keeps the codebase that a session started with. A started tab
  // must not show one that its session does not have.
  test('a session that started keeps what it has', () => {
    const { state, update } = strip(runAt('/code/shop'), () => [shop])
    state.isStarted = true
    update()
    expect(codebaseOf(state.run)).toBeNull()
  })

  // A person deleted the codebase on a different client, or on the page of the codebase, and the record of the session names it still.
  // The next prompt must not name a deleted codebase, and the views must not show one.
  test('a run whose codebase is deleted has none, also after its session started', () => {
    const { state, update } = strip(runAt('/code/shop', 'shop'), () => [])
    state.isStarted = true
    update()
    expect(codebaseOf(state.run)).toBe('shop')
    state.deleted.push('shop')
    update()
    expect(codebaseOf(state.run)).toBeNull()
    // The person did not choose "No codebase": the run refuses none.
    expect(refusesCodebase(state.run)).toBe(false)
  })

  // The worktree shortcut asks for a new worktree with no menu open. A folder
  // with no repository has no branch for it, so the field must come to the person.
  test('opens the start control when a new worktree of a plain folder gets no base branch', () => {
    const { state, update } = strip(runAt('/code/notes', 'shop'), () => [shop])
    update()
    expect(state.opened).toBe(0)
    state.needsBaseBranch = true
    update()
    expect(state.opened).toBe(1)
    update()
    expect(state.opened).toBe(1)
  })

  test('a run restored in that state opens nothing', () => {
    const { state, update } = strip(runAt('/code/notes', 'shop'), () => [shop])
    state.needsBaseBranch = true
    update()
    expect(state.opened).toBe(0)
  })
})

describe('a choice of a codebase', () => {
  const workspaceOf = (state: { run: RunConfig }, moved: string[]) => ({
    runFor: () => state.run,
    defaultRunConfig: state.run,
    moveRun: (_sourceId: string, next: RunLocation) => { state.run = { ...state.run, location: next } },
    config: {
      setBaseDirectory: async (path: string) => {
        moved.push(path)
        state.run = { ...state.run, location: openFolder(state.run.location, { serverId: 'laptop', path }) }
      },
    },
  })

  test('a codebase that holds the folder of the run keeps the folder, and the chip shows the codebase', async () => {
    const state = { run: runAt('/code/shop/api') }
    const moved: string[] = []
    const [option] = codebaseChipOptions([platform], { serverId: 'laptop', projectPath: '/code/shop/api', codebaseId: null }, hostOf)
    expect(codebaseChoiceStep(option!)).toEqual({ kind: 'keep' })
    await aimRunAtCodebase(workspaceOf(state, moved) as never, { refresh: async () => true }, 'draft-1', { codebaseId: 'platform' }, new CodebaseDecisions())
    expect(moved).toEqual([])
    expect(checkoutPlace(state.run).path).toBe('/code/shop/api')
    expect(codebaseOf(state.run)).toBe('platform')
    expect(chipAtRest('api', platform)).toEqual({ kind: 'codebase', name: 'platform', note: null })
  })

  test('a codebase that does not hold the folder opens its first root on the run host', async () => {
    const state = { run: runAt('/code/other') }
    const moved: string[] = []
    const [option] = codebaseChipOptions([platform], { serverId: 'laptop', projectPath: '/code/other', codebaseId: null }, hostOf)
    const step = codebaseChoiceStep(option!)
    expect(step.kind).toBe('open')
    if (step.kind !== 'open') return
    await aimRunAtCodebase(workspaceOf(state, moved) as never, { refresh: async () => true }, 'draft-1', { codebaseId: 'platform', root: step.root }, new CodebaseDecisions())
    expect(moved).toEqual(['/code/shop/api'])
    expect(checkoutPlace(state.run).path).toBe('/code/shop/api')
    expect(codebaseOf(state.run)).toBe('platform')
  })

  test('a root on another host moves the run there and sets the codebase', async () => {
    let run = runAt('/code/other')
    const refreshed: string[] = []
    const workspace = {
      runFor: () => run,
      defaultRunConfig: run,
      moveRun: (_sourceId: string, next: RunLocation) => { run = { ...run, location: next } },
      config: { setBaseDirectory: async () => { throw new Error('a folder on another host is not a folder change') } },
    }
    await aimRunAtCodebase(
      workspace as never,
      { refresh: async (serverId: string, path: string) => { refreshed.push(`${serverId}:${path}`); return true } },
      'draft-1',
      { codebaseId: 'infra', root: { serverId: 'build', path: '/srv/infra' } },
      new CodebaseDecisions(),
    )
    expect(runHost(run)).toBe('build')
    expect(checkoutPlace(run).path).toBe('/srv/infra')
    expect(codebaseOf(run)).toBe('infra')
    expect(refreshed).toEqual(['build:/srv/infra'])
  })
})
