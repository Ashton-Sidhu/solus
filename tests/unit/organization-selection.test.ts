import { describe, expect, test } from 'bun:test'
import { ACTIVE_ORGANIZATION_KEY, OrganizationSelection, type SelectionStorage } from '@solus/client-core/organization-selection'

function storage(organizationId?: string): SelectionStorage {
  const values = new Map<string, string>()
  if (organizationId) values.set(ACTIVE_ORGANIZATION_KEY, organizationId)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}
const workspaces = [{ organizationId: 'A', isActive: true }, { organizationId: 'B', isActive: false }]

describe('window organization selection', () => {
  test('a window that never explicitly selects stays on A when another window selects B', () => {
    const device = storage()
    const firstWindow = storage()
    const first = new OrganizationSelection(() => ({ window: firstWindow, device }))
    const second = new OrganizationSelection(() => ({ window: storage(), device }))
    const seen: Array<string | null> = []
    first.subscribe((organizationId) => { seen.push(organizationId) })
    expect(first.reconcile(workspaces)).toBe('A')
    second.set('B')
    // Connection reads and directory refreshes use the same authority as the UI.
    expect(first.reconcile(workspaces)).toBe('A')
    expect(first.organizationId).toBe('A')
    expect(firstWindow.getItem(ACTIVE_ORGANIZATION_KEY)).toBe('A')
    expect(seen).toEqual(['A'])
    const next = new OrganizationSelection(() => ({ window: storage(), device }))
    expect(next.reconcile(workspaces)).toBe('B')
  })

  test('window storage wins over the device seed; loss of membership selects an available organization', () => {
    const window = storage('A')
    const selection = new OrganizationSelection(() => ({ window, device: storage('B') }))
    expect(selection.reconcile(workspaces)).toBe('A')
    expect(selection.reconcile([workspaces[1]])).toBe('B')
    expect(window.getItem(ACTIVE_ORGANIZATION_KEY)).toBe('B')
    expect(selection.reconcile([])).toBeNull()
  })

  test('empty boot cache does not consume the stored choice', () => {
    const selection = new OrganizationSelection(() => ({ window: storage(), device: storage('B') }))
    expect(selection.reconcile([])).toBeNull()
    expect(selection.reconcile(workspaces)).toBe('B')
  })

  test('denied storage preserves the in-memory choice for both UI and connection reads', () => {
    const broken: SelectionStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    const selection = new OrganizationSelection(() => ({ window: broken, device: broken }))
    expect(selection.reconcile(workspaces)).toBe('A')
    expect(selection.set('B')).toBe(true)
    expect(selection.reconcile(workspaces)).toBe('B')
    expect(selection.set('B')).toBe(false)
  })
})
