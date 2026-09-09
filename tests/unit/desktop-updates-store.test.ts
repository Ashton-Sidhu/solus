import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DesktopUpdateStatus } from '@solus/contracts/desktop-update-types'

// The renderer's mirror of the desktop update status. What matters: each
// prompt is owed once per release (a status re-broadcast never re-arms it), a
// download prompt is owed only while auto-download is off, and only a check
// the user asked for earns a result toast.

declare global {
  var $state: <T>(value: T) => T
}

const originalState = globalThis.$state
beforeEach(() => {
  globalThis.$state = <T>(value: T): T => value
})
afterEach(() => {
  globalThis.$state = originalState
})

const release = { version: '0.31.0', releaseNotes: null, releaseDate: null }

function status(state: DesktopUpdateStatus['state'], autoDownload = true): DesktopUpdateStatus {
  return { currentVersion: '0.30.0', autoDownload, state }
}

async function storeWithFakeShell() {
  const { UpdatesStore } = await import('@solus/workspace-ui/contexts/updates/updates.store.svelte')
  let push: ((status: DesktopUpdateStatus) => void) | null = null
  const calls: string[] = []
  const store = new UpdatesStore({
    updateStatus: async () => status({ kind: 'idle' }),
    onUpdateStatusChange: (callback) => {
      push = callback
      return () => {}
    },
    checkForUpdate: async () => { calls.push('check') },
    downloadUpdate: async () => { calls.push('download') },
    restartToUpdate: () => { calls.push('restart') },
    setUpdateAutoDownload: async () => {},
  })
  store.start()
  return { store, calls, push: (next: DesktopUpdateStatus) => push?.(next) }
}

describe('UpdatesStore', () => {
  test('is unavailable without a shell capability', async () => {
    const { UpdatesStore } = await import('@solus/workspace-ui/contexts/updates/updates.store.svelte')
    const store = new UpdatesStore({})
    expect(store.isAvailable).toBe(false)
    expect(store.state).toEqual({ kind: 'idle' })
    expect(store.pendingPrompt).toBeNull()
  })

  test('owes a restart prompt once per ready release', async () => {
    const { store, push } = await storeWithFakeShell()
    push(status({ kind: 'ready', release }))
    expect(store.pendingPrompt).toBe('restart')
    store.markPromptShown('restart')
    expect(store.pendingPrompt).toBeNull()
    push(status({ kind: 'ready', release }))
    expect(store.pendingPrompt).toBeNull()
    push(status({ kind: 'ready', release: { ...release, version: '0.32.0' } }))
    expect(store.pendingPrompt).toBe('restart')
  })

  test('owes a download prompt only while auto-download is off', async () => {
    const { store, push } = await storeWithFakeShell()
    push(status({ kind: 'available', release }, true))
    expect(store.pendingPrompt).toBeNull()
    push(status({ kind: 'available', release }, false))
    expect(store.pendingPrompt).toBe('download')
    store.markPromptShown('download')
    expect(store.pendingPrompt).toBeNull()
  })

  test('reports the outcome of a manual check, and stays silent for a background one', async () => {
    const { store, push } = await storeWithFakeShell()
    push(status({ kind: 'up-to-date', checkedAt: 1 }))
    expect(store.manualCheckOutcome).toBeNull()
    await store.check()
    push(status({ kind: 'checking' }))
    expect(store.manualCheckOutcome).toBeNull()
    push(status({ kind: 'error', message: 'offline', release: null }))
    expect(store.manualCheckOutcome).toBe('error')
    store.markManualCheckReported()
    expect(store.manualCheckOutcome).toBeNull()
  })
})
