import { describe, expect, test } from 'bun:test'
import type { AppSummary, AppsChangedEvent } from '@solus/contracts/apps'
import type { AppShortcutTarget, AppShortcutView } from '@solus/contracts/app-shortcuts'
import { AppDesktopFollower } from '@solus/workspace-ui/contexts/apps/app-desktop-follower'

// This computer's records of each app follow the app's host
// (docs/app-shortcuts.md §3 and §4). What matters: a delete from any client
// clears the app here, a deploy that changes the icon or the name writes the
// launcher again without an open, and a host that connects clears an app that
// is gone from its list, but a list that fails to read clears nothing.

const HOST = '0123456789abcdef0123456789abcdef'
const SERVER = 'server-1'
const notes: AppShortcutTarget = { host: HOST, appId: 'notes' }
const tasks: AppShortcutTarget = { host: HOST, appId: 'tasks' }

function summary(id: string, overrides: Partial<AppSummary> = {}): AppSummary {
  return { id, name: id, colorHue: null, iconHash: null, ...overrides } as AppSummary
}

function view(target: AppShortcutTarget): AppShortcutView {
  return { ...target, name: target.appId, iconKey: '', isOutdated: false }
}

function follower(options: { shortcuts?: AppShortcutTarget[]; answered?: AppShortcutTarget[]; list?: () => Promise<AppSummary[]>; ready?: string[] } = {}) {
  const forgotten: AppShortcutTarget[] = []
  const followed: { target: AppShortcutTarget; serverId: string; name: string }[] = []
  let changed: ((serverId: string, event: AppsChangedEvent) => void) | null = null
  let ready: ((serverId: string) => void) | null = null
  let reads = 0
  const shortcuts = (options.shortcuts ?? []).map(view)
  const instance = new AppDesktopFollower({
    shortcuts: {
      isAvailable: true,
      loaded: async () => {},
      get list() { return shortcuts },
      follow: async (target, serverId, app) => { followed.push({ target, serverId, name: app.name }) },
      forgetApp: async (target) => { forgotten.push(target) },
    },
    answeredApps: async () => options.answered ?? [],
    hostKeyOf: () => HOST,
    readyHosts: () => options.ready ?? [],
    appList: async () => {
      reads += 1
      return options.list ? options.list() : []
    },
    onAppsChanged: (listener) => {
      changed = listener
      return () => { changed = null }
    },
    onHostReady: (listener) => {
      ready = listener
      return () => { ready = null }
    },
  })
  const stop = instance.start()
  return {
    instance,
    stop,
    forgotten,
    followed,
    reads: () => reads,
    emit: (event: AppsChangedEvent) => changed?.(SERVER, event),
    connect: () => ready?.(SERVER),
  }
}

const settle = () => Bun.sleep(0)

describe('the desktop follower of apps', () => {
  test('a delete from any client clears the app on this computer', async () => {
    const f = follower({ shortcuts: [notes] })
    f.emit({ kind: 'deleted', appId: 'notes' })
    await settle()
    expect(f.forgotten).toEqual([notes])
  })

  test('a change of an app with a shortcut writes its launcher when it changed, and leaves other apps alone', async () => {
    const f = follower({ shortcuts: [notes] })
    f.emit({ kind: 'saved', app: summary('notes', { name: 'Notebook', iconHash: 'abc' }) })
    f.emit({ kind: 'saved', app: summary('tasks') })
    await settle()
    expect(f.followed).toEqual([{ target: notes, serverId: SERVER, name: 'Notebook' }])
  })

  test('a host that connects clears an app gone from its list and refreshes one that is there', async () => {
    const f = follower({ shortcuts: [notes], answered: [tasks], list: async () => [summary('notes')] })
    f.connect()
    await settle()
    await settle()
    expect(f.forgotten).toEqual([tasks])
    expect(f.followed.map((entry) => entry.target)).toEqual([notes])
  })

  // WHY: only a host's answer says that an app is gone. A host that is down must not wipe the person's shortcuts.
  test('a list that fails to read clears nothing', async () => {
    const f = follower({ shortcuts: [notes], list: async () => { throw new Error('offline') } })
    f.connect()
    await settle()
    expect(f.forgotten).toEqual([])
  })

  test('a host with no record of this computer is not read', async () => {
    const f = follower({ ready: [SERVER] })
    await settle()
    f.connect()
    await settle()
    expect(f.reads()).toBe(0)
  })

  test('hosts that are connected at the start are read once', async () => {
    const f = follower({ shortcuts: [notes], ready: [SERVER], list: async () => [] })
    await settle()
    await settle()
    expect(f.forgotten).toEqual([notes])
  })
})
