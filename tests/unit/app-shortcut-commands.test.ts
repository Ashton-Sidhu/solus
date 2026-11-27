import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AppShortcutTarget, AppShortcutView } from '@solus/contracts/app-shortcuts'

// The app shortcut commands of the account and host actions
// (docs/app-shortcuts.md §5). What matters: removing a host offers to remove
// the shortcuts of its apps and does not remove them unasked; the offer takes
// only that host's shortcuts; "Remove all" asks with the count first; and a
// failure offers "Try again".

declare global {
  var $state: <T>(value: T) => T
}
globalThis.$state = <T>(value: T): T => value

interface ShownToast {
  message: string
  action?: { label: string; onAction: () => void }
  description?: string
}
const shown: ShownToast[] = []
const settled: Array<{ variant: string; message: string; action?: ShownToast['action'] }> = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: {
    info: (message: string, opts: Omit<ShownToast, 'message'> = {}) => shown.push({ message, ...opts }),
    progress: () => ({
      info: (message: string) => settled.push({ variant: 'info', message }),
      success: (message: string) => settled.push({ variant: 'success', message }),
      error: (message: string, opts: { action?: ShownToast['action'] } = {}) => settled.push({ variant: 'error', message, action: opts.action }),
      dismiss: () => {},
    }),
  },
}))

const studio = '0123456789abcdef0123456789abcdef'
const laptop = '89abcdef0123456789abcdef01234567'
let shortcuts: AppShortcutView[] = []
let refuses = false
const removed: AppShortcutTarget[] = []
mock.module('@solus/client-core/local-api', () => ({
  localApi: {
    appShortcuts: async () => shortcuts,
    removeAppShortcut: async (target: AppShortcutTarget) => {
      if (refuses) throw new Error('The desktop app did not answer.')
      removed.push(target)
      shortcuts = shortcuts.filter((shortcut) => shortcut.appId !== target.appId)
      return { launcher: 'trashed' }
    },
  },
}))

const { offerToRemoveHostAppShortcuts, removeAllAppShortcuts } = await import('@solus/workspace-ui/contexts/apps/app-shortcut-commands')
const { appShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')

beforeEach(async () => {
  shortcuts = [
    { host: studio, appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b', name: 'Notes' },
    { host: studio, appId: '11111111-2222-4333-8444-555555555555', name: 'Tasks' },
    { host: laptop, appId: '22222222-3333-4444-8555-666666666666', name: 'Journal' },
  ]
  refuses = false
  removed.length = 0
  shown.length = 0
  settled.length = 0
  await appShortcutsStore.checkAgain()
})

describe('after a host is removed from this client', () => {
  // WHY: a host can be paired again with the same identity, and its launchers then open again. They go only when the person says so.
  test('the shortcuts of its apps are offered for removal, not removed', async () => {
    await offerToRemoveHostAppShortcuts('connection-1', { installationId: studio, label: 'Studio Mac' })
    expect(removed).toEqual([])
    expect(shown.map((toast) => toast.message)).toEqual(['Studio Mac has 2 app shortcuts on this computer.'])
    shown[0].action?.onAction()
    await Bun.sleep(0)
    expect(removed.map((target) => target.host)).toEqual([studio, studio])
    expect(appShortcutsStore.list.map((shortcut) => shortcut.name)).toEqual(['Journal'])
  })

  test('a host with no app shortcut on this computer gets no offer', async () => {
    await offerToRemoveHostAppShortcuts('connection-2', { installationId: 'ffffffffffffffffffffffffffffffff', label: 'Old box' })
    expect(shown).toEqual([])
  })
})

describe('Remove all app shortcuts', () => {
  test('it asks with the count, and nothing goes when the person says no', async () => {
    const questions: string[] = []
    await removeAllAppShortcuts((question) => {
      questions.push(question)
      return false
    })
    expect(questions[0]).toContain('all 3 app shortcuts')
    expect(removed).toEqual([])
  })

  test('a failure says so and offers to try the failed ones again', async () => {
    refuses = true
    await removeAllAppShortcuts(() => true)
    expect(settled.at(-1)?.variant).toBe('error')
    expect(settled.at(-1)?.message).toBe('3 app shortcuts not removed.')
    expect(settled.at(-1)?.action?.label).toBe('Try again')
    refuses = false
    settled.at(-1)?.action?.onAction()
    await Bun.sleep(0)
    expect(removed).toHaveLength(3)
    expect(appShortcutsStore.list).toEqual([])
  })
})
