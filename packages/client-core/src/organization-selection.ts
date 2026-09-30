/**
 * Which organization one window works in (docs/plans/organization-scope.md §2,
 * §7). The selection is a client filter: it never changes a record's
 * organization, a running session, or another window's selection. Each window
 * (a desktop window, a web tab, a mobile view) keeps its own choice in
 * `sessionStorage`; the last choice made on this device seeds a new window
 * through `localStorage`. With no choice saved, the directory's active
 * organization wins, then the first workspace.
 *
 * The selection is held in memory; injected storage keeps the rule testable.
 */

export const ACTIVE_ORGANIZATION_KEY = 'solus.activeOrganizationId'

/** The part of `Storage` this module uses. */
export interface SelectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface OrganizationSelectionStorages {
  /** Per window: `sessionStorage`. Null when the environment has none. */
  window: SelectionStorage | null
  /** Per device: `localStorage`, the seed for a new window. Null when the environment has none. */
  device: SelectionStorage | null
}

/** What the rule needs of a saved workspace. */
export interface SelectableWorkspace {
  organizationId: string
  isActive: boolean
}

function read(storage: SelectionStorage | null, key: string): string | null {
  try {
    const value = storage?.getItem(key)
    return value ? value : null
  } catch {
    return null
  }
}

/** One selection authority per window. Storage seeds it once; it is not a live source. */
export class OrganizationSelection {
  private selected: string | null | undefined
  private readonly listeners = new Set<(organizationId: string | null) => void>()

  constructor(private readonly storages: () => OrganizationSelectionStorages = browserSelectionStorages) {}

  get organizationId(): string | null { return this.selected ?? null }

  subscribe(listener: (organizationId: string | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Keep the choice while it is authorized, even if another window changes the device seed. */
  reconcile(workspaces: readonly SelectableWorkspace[]): string | null {
    // An empty boot cache is not a selection. Wait for the first directory.
    if (this.selected === undefined && workspaces.length === 0) return null
    const storages = this.storages()
    const choice = this.selected === undefined
      ? read(storages.window, ACTIVE_ORGANIZATION_KEY) ?? read(storages.device, ACTIVE_ORGANIZATION_KEY)
      : this.selected
    const next = workspaces.some((workspace) => workspace.organizationId === choice)
      ? choice
      : (workspaces.find((workspace) => workspace.isActive) ?? workspaces[0])?.organizationId ?? null
    this.update(next)
    write(storages.window, next)
    return next
  }

  /** Explicit selection also supplies the seed for the next window. */
  set(organizationId: string): boolean {
    const changed = this.update(organizationId)
    const storages = this.storages()
    write(storages.window, organizationId)
    write(storages.device, organizationId)
    return changed
  }

  private update(organizationId: string | null): boolean {
    if (this.selected === organizationId) return false
    this.selected = organizationId
    for (const listener of this.listeners) listener(organizationId)
    return true
  }
}

function write(storage: SelectionStorage | null, organizationId: string | null): void {
  try {
    if (organizationId) storage?.setItem(ACTIVE_ORGANIZATION_KEY, organizationId)
    else storage?.removeItem(ACTIVE_ORGANIZATION_KEY)
  } catch {
    // Storage failure cannot change the window's in-memory selection.
  }
}

export const windowOrganizationSelection = new OrganizationSelection()

/** The browser's storages; each is null where the environment has none (a unit test, a worker). */
export function browserSelectionStorages(): OrganizationSelectionStorages {
  // SAFETY: a browser's `Storage` satisfies `SelectionStorage`; where the globals are absent the reads answer undefined, which becomes null below.
  const scope = globalThis as { sessionStorage?: SelectionStorage; localStorage?: SelectionStorage }
  let window: SelectionStorage | null = null
  let device: SelectionStorage | null = null
  try { window = scope.sessionStorage ?? null } catch {}
  try { device = scope.localStorage ?? null } catch {}
  return { window, device }
}
