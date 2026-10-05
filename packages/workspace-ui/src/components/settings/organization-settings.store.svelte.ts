import { SvelteMap } from 'svelte/reactivity'
import { OrganizationSettingsClient, type OrganizationSettingsWriteResult } from '@solus/client-core/settings-sync'
import type { OrganizationSettingsResult } from '@solus/client-core/settings-requests'
import type { OrganizationSettingsResponse } from '@solus/contracts/settings'
import { accountSettingsRequests } from '../../contexts/app/settings-sync.store.svelte'
import { changedSettings, draftFrom, isDraftDirty, type OrganizationDraft } from './lib/organization-draft'

/**
 * One organization's settings as this account reads them (plans/018 §4, §7).
 * `forbidden`: not a member, or the organization is gone. A member reads; only
 * `canManageSettings` — computed by the control plane — shows editors.
 */
export type OrganizationSettingsView =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'signed-out' }
  | { status: 'offline' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      settings: OrganizationSettingsResponse
      draft: OrganizationDraft
      saving: boolean
      /** The last save's refusal, in words. */
      error: string | null
      /** Another owner saved first: what they saved. The draft is kept until the owner chooses. */
      conflict: OrganizationSettingsResponse | null
    }

type ReadyView = Extract<OrganizationSettingsView, { status: 'ready' }>

/**
 * Organization settings per account origin and organization. A draft is the
 * owner's own until Save, which sends it against the revision that was read;
 * nothing is queued offline, and a conflict keeps the draft beside what the
 * other owner saved. Final authority is the control plane and, for work, the host.
 */
export class OrganizationSettingsStore {
  readonly views = new SvelteMap<string, OrganizationSettingsView>()
  /** The organization Settings shows. Chosen here only: it changes no window's or session's organization. */
  selectedOrganizationId = $state<string | null>(null)
  private readonly loads = new Map<string, symbol>()

  constructor(private readonly client: () => OrganizationSettingsClient | null = defaultClient) {}

  viewFor(origin: string, organizationId: string): OrganizationSettingsView | undefined {
    return this.views.get(viewKey(origin, organizationId))
  }

  async load(origin: string, organizationId: string): Promise<void> {
    const key = viewKey(origin, organizationId)
    const client = this.client()
    if (!client) {
      this.views.set(key, { status: 'signed-out' })
      return
    }
    const load = Symbol()
    this.loads.set(key, load)
    const previous = this.views.get(key)
    // A reload keeps a draft in progress on screen; it does not discard it.
    if (previous?.status !== 'ready') this.views.set(key, { status: 'loading' })
    const result = await client.read(organizationId)
    if (this.loads.get(key) !== load) return
    const current = this.views.get(key)
    if (result.kind === 'ok' && current?.status === 'ready' && current.saving) return
    this.views.set(key, viewFrom(result, current?.status === 'ready' ? current : null))
  }

  /** Changes the owner's draft. A member, a save in flight, or an open conflict changes nothing. */
  edit(origin: string, organizationId: string, change: Partial<OrganizationDraft>): void {
    const view = this.ready(origin, organizationId)
    if (!view || view.saving || view.conflict || !view.settings.canManageSettings) return
    this.views.set(viewKey(origin, organizationId), { ...view, draft: { ...view.draft, ...change }, error: null })
  }

  /** Cancel: the draft returns to what was last read. */
  cancel(origin: string, organizationId: string): void {
    const view = this.ready(origin, organizationId)
    if (!view || view.saving) return
    this.views.set(viewKey(origin, organizationId), { ...view, draft: draftFrom(view.settings), error: null, conflict: null })
  }

  /**
   * After a conflict: `use-theirs` drops the draft for what the other owner saved;
   * `keep-mine` keeps the draft over their revision, to be saved again on purpose.
   */
  resolveConflict(origin: string, organizationId: string, choice: 'use-theirs' | 'keep-mine'): void {
    const view = this.ready(origin, organizationId)
    if (!view?.conflict) return
    const settings = view.conflict
    this.views.set(viewKey(origin, organizationId), {
      ...view,
      settings,
      draft: choice === 'use-theirs' ? draftFrom(settings) : view.draft,
      conflict: null,
      error: null,
    })
  }

  /** Saves the changed settings against the revision read. */
  async save(origin: string, organizationId: string): Promise<void> {
    const key = viewKey(origin, organizationId)
    const view = this.ready(origin, organizationId)
    const client = this.client()
    if (!view || !client || view.saving || view.conflict || !view.settings.canManageSettings) return
    const changes = changedSettings(view.settings.settings, view.draft)
    if (Object.keys(changes).length === 0) return
    this.views.set(key, { ...view, saving: true, error: null })
    const result = await client.save(organizationId, view.settings.revision, changes)
    if (!this.afterWrite(key, result, view.draft) || result.kind !== 'ok') return
    this.views.set(key, { status: 'ready', settings: result.settings, draft: draftFrom(result.settings), saving: false, error: null, conflict: null })
  }

  /** True when the save may go on; otherwise the view says why it stopped. */
  private afterWrite(key: string, result: OrganizationSettingsWriteResult, draft: OrganizationDraft): boolean {
    if (result.kind === 'ok') return true
    const view = this.views.get(key)
    if (!view || view.status !== 'ready') return false
    if (result.kind === 'conflict') {
      this.views.set(key, { ...view, draft, saving: false, conflict: result.current })
      return false
    }
    if (result.kind === 'forbidden') {
      // Permission lost while editing: the draft goes, and the page says so.
      this.views.set(key, { status: 'forbidden' })
      return false
    }
    const message = result.kind === 'offline'
      ? 'Solus could not reach your account. Nothing was saved; try again when you are online.'
      : result.kind === 'signed-out'
        ? 'Sign in to Solus again to save organization settings.'
        : result.message ?? (result.kind === 'invalid' ? 'These settings are not valid.' : `Saving failed (${result.code}).`)
    this.views.set(key, { ...view, draft, saving: false, error: message })
    return false
  }

  private ready(origin: string, organizationId: string): ReadyView | null {
    const view = this.views.get(viewKey(origin, organizationId))
    return view?.status === 'ready' ? view : null
  }
}

function viewKey(origin: string, organizationId: string): string {
  return `${origin}|${organizationId}`
}

/** A read's view. A fresh read replaces what was read; a draft in progress stays, marked stale by a revision change. */
function viewFrom(result: OrganizationSettingsResult, previous: ReadyView | null): OrganizationSettingsView {
  if (result.kind === 'forbidden') return { status: 'forbidden' }
  if (result.kind === 'signed-out') return { status: 'signed-out' }
  if (result.kind === 'offline') return previous ?? { status: 'offline' }
  if (result.kind === 'error') return previous ?? { status: 'error', message: result.message ?? `Solus could not read these settings (${result.code}).` }
  const settings = result.kind === 'ok' ? result.settings : result.current
  if (previous && !previous.saving) {
    const dirty = isDraftDirty(previous.settings, previous.draft)
    const moved = previous.settings.revision !== settings.revision
    if (dirty && moved) return { ...previous, conflict: settings }
    if (dirty) return { ...previous, settings }
  }
  return { status: 'ready', settings, draft: draftFrom(settings), saving: false, error: null, conflict: null }
}

function defaultClient(): OrganizationSettingsClient | null {
  const requests = accountSettingsRequests()
  return requests ? new OrganizationSettingsClient(requests) : null
}

export const organizationSettingsStore = new OrganizationSettingsStore()
