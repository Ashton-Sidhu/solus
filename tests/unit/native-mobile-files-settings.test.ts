import { describe, expect, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import { buildFileTree, childPath, folderListing, folderTitle, visibleTreeRows } from '../../apps/mobile/src/features/files/lib/file-tree'
import { ProjectFiles } from '../../apps/mobile/src/features/files/project-files'
import { AppearancePreference, type AppearanceMode } from '../../apps/mobile/src/features/settings/appearance'
import { HostSettings } from '../../apps/mobile/src/features/settings/host-settings'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import { updateStatusText } from '../../apps/mobile/src/features/settings/lib/update-status'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

// plan 017 stage 5: files, settings, and appearance on the phone. The rules
// pinned here are the ones a person would notice going wrong: a folder that
// holds only subfolders still appears, a setting the host refused does not
// stay on screen, and a change made on another device shows here. Personal
// settings and their sync are in native-mobile-settings-sync.test.ts.

async function hostWorld(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  return world
}

describe('project file tree', () => {
  const tree = buildFileTree(['src/app.ts', 'src/lib/util.ts', 'README.md', 'src/App.tsx'], ['docs/drafts/'])

  test('lists folders before files, alphabetically, at every level', () => {
    expect(folderListing(tree, '')).toEqual({ folders: ['docs', 'src'], files: ['README.md'] })
    expect(folderListing(tree, 'src')).toEqual({ folders: ['lib'], files: ['app.ts', 'App.tsx'] })
  })

  test('keeps a folder that holds no indexed file, and its parents', () => {
    expect(folderListing(tree, 'docs')).toEqual({ folders: ['drafts'], files: [] })
    expect(folderListing(tree, 'docs/drafts')).toEqual({ folders: [], files: [] })
  })

  test('joins and names paths from the root', () => {
    expect(childPath('', 'src')).toBe('src')
    expect(childPath('src', 'lib')).toBe('src/lib')
    expect(folderTitle('', 'solus')).toBe('solus')
    expect(folderTitle('src/lib', 'solus')).toBe('lib')
  })

  test('shows an expanded folder\'s children below it, one level deeper', () => {
    const rows = visibleTreeRows(tree, '', new Set(['src']))
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual(['0:docs', '0:src', '1:src/lib', '1:src/app.ts', '1:src/App.tsx', '0:README.md'])
    expect(rows.find((row) => row.path === 'src')?.childCount).toBe(3)
  })

  test('a search finds files in closed folders and keeps the folders that lead to them', () => {
    const rows = visibleTreeRows(tree, '', new Set(), 'util')
    expect(rows.map((row) => row.path)).toEqual(['src', 'src/lib', 'src/lib/util.ts'])
  })

  test('reads a project once through the host index, scoped to the project folder', async () => {
    const api = new FakeApi().on('listProjectFiles', () => ({ ok: true, root: '/work/app', files: ['a.ts'], truncated: true, source: 'index' }))
    const world = await hostWorld(api)
    const files = new ProjectFiles((hostId) => world.connections.connection(hostId), () => null)
    await files.load('inst-a', '/work/app')
    const state = files.stateOf('inst-a', '/work/app')
    expect(state.kind === 'loaded' && state.index.truncated).toBe(true)
    const [ctx, request] = api.callsOf('listProjectFiles')[0]! as [{ session: { workingDirectory: string; sessionId: string } }, unknown]
    expect(request).toEqual({ cwd: '/work/app', includeEmptyDirectories: true })
    expect(ctx.session.workingDirectory).toBe('/work/app')
    expect(ctx.session.sessionId).toBe('')
  })
})

describe('host settings', () => {
  test('a change the host refused shows what the host holds, not the change', async () => {
    const held = { ...DEFAULT_HOST_CONFIG, continueSessionsAfterHostRestart: true }
    const api = new FakeApi()
      .on('configGet', () => ({ config: held, typeSafe: { source: null } }))
      .on('configUpdate', () => { throw new Error('not allowed') })
    const world = await hostWorld(api)
    const settings = new HostSettings((hostId) => world.connections.connection(hostId))
    await settings.load('inst-a')
    await expect(settings.update('inst-a', { continueSessionsAfterHostRestart: false })).rejects.toThrow('not allowed')
    const state = settings.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.settings.continueSessionsAfterHostRestart).toBe(true)
  })

  test('a change made on another device shows here', async () => {
    const api = new FakeApi().on('configGet', () => ({ config: DEFAULT_HOST_CONFIG, typeSafe: { source: null } }))
    const world = await hostWorld(api)
    const settings = new HostSettings((hostId) => world.connections.connection(hostId))
    await settings.load('inst-a')
    world.transports[0]!.emit('config.changed', { config: { ...DEFAULT_HOST_CONFIG, continueSessionsAfterHostRestart: false }, typeSafe: { source: null } })
    await flushPromises()
    const state = settings.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.settings.continueSessionsAfterHostRestart).toBe(false)
  })
})

describe('appearance', () => {
  test('a saved choice survives a restart and is applied at launch', () => {
    const storage = memoryKeyValueStore()
    const applied: AppearanceMode[] = []
    const first = new AppearancePreference(new PersonalSettingsStore(storage), (mode) => applied.push(mode))
    first.applySaved()
    first.set('dark')
    const relaunched = new AppearancePreference(new PersonalSettingsStore(storage), (mode) => applied.push(mode))
    relaunched.applySaved()
    expect(relaunched.current()).toBe('dark')
    expect(applied).toEqual(['system', 'dark', 'dark'])
  })
})

describe('update status', () => {
  test('a cloud host is updated for the person, whatever its check says', () => {
    expect(updateStatusText({ install: 'cloud', check: { kind: 'available', latestVersion: '2.0.0', checkedAt: 0 } })).toBe('Updated by Solus Cloud')
    expect(updateStatusText({ install: 'desktop', check: { kind: 'available', latestVersion: '2.0.0', checkedAt: 0 } })).toBe('Version 2.0.0 is available')
  })
})
