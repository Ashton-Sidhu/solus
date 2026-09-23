import { afterEach, describe, expect, test } from 'bun:test'
import { loadProjectPageScope, saveProjectPageScope } from '@solus/workspace-ui/contexts/projects/page-scope-preference'

const previousStorage = globalThis.localStorage
function installStorage(): void {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  })
}
afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
})

describe('project page scope preference', () => {
  test('the pages reopen on the project last chosen, after a reload', () => {
    // WHY: docs/plans/project-model.md §5 — All projects the first time, then the
    // person's own last choice. Losing it on every reload sent them back to All.
    installStorage()
    expect(loadProjectPageScope()).toEqual({ kind: 'all' })
    const scope = { kind: 'project' as const, key: 'github.com/acme/web', checkout: { serverId: 'laptop', projectRoot: '/Users/me/web' } }
    saveProjectPageScope(scope)
    expect(loadProjectPageScope()).toEqual(scope)
  })

  test('a stored value that is not a scope reads as All projects', () => {
    installStorage()
    globalThis.localStorage.setItem('solus.projectPageScope', JSON.stringify({ kind: 'host', serverId: 'x' }))
    expect(loadProjectPageScope()).toEqual({ kind: 'all' })
  })
})
