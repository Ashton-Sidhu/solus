import { SvelteMap } from 'svelte/reactivity'
import type { PolicyApiResult } from '@solus/contracts/host-api'
import { organizationSettingsResponseSchema, type OrganizationHostRules, type OrganizationSettingsPatchRequest, type OrganizationSettingsResponse } from '@solus/contracts/policy-api'
import type { PolicyCloudRequests } from '@solus/client-core/settings-requests'
import { accountSettingsRequests } from '../../../contexts/account/account-sync.store.svelte'
import { canManageOrganization, organizationSettingsMessage, sameHostRules } from './lib/organization-settings'

/**
 * One organization's settings as this account reads them: name, members, and host
 * rules. `forbidden`: not a member, or the organization is gone. Every member reads;
 * only an owner writes, and Solus Cloud checks the role again on each write.
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
      /** A write in flight. */
      isSaving: boolean
      /** Why the last write was refused; null after a good one. */
      saveError: string | null
    }

type ReadyView = Extract<OrganizationSettingsView, { status: 'ready' }>

/** The settings of each organization by account origin. */
export class OrganizationSettingsStore {
  readonly views = new SvelteMap<string, OrganizationSettingsView>()
  /** The organization Settings shows. Chosen here only: it changes no window's or session's organization. */
  selectedOrganizationId = $state<string | null>(null)
  private readonly loads = new Map<string, symbol>()

  constructor(private readonly requests: () => PolicyCloudRequests | null = accountSettingsRequests) {}

  viewFor(origin: string, organizationId: string): OrganizationSettingsView | undefined {
    return this.views.get(viewKey(origin, organizationId))
  }

  async load(origin: string, organizationId: string): Promise<void> {
    const key = viewKey(origin, organizationId)
    const requests = this.requests()
    if (!requests) {
      this.views.set(key, { status: 'signed-out' })
      return
    }
    const load = Symbol()
    this.loads.set(key, load)
    if (this.views.get(key)?.status !== 'ready') this.views.set(key, { status: 'loading' })
    const result = await requests.organizationSettingsGet(organizationId)
    if (this.loads.get(key) !== load) return
    if (result.kind === 'ok') return this.show(key, result.value)
    // Offline or a failed read keeps what is on screen; a lost membership does not.
    if (this.views.get(key)?.status === 'ready' && (result.kind === 'offline' || result.kind === 'error')) return
    this.views.set(key, failedView(result))
  }

  /** An owner renames the organization. True when it was saved. */
  rename(origin: string, organizationId: string, name: string): Promise<boolean> {
    const ready = this.ready(origin, organizationId)
    const trimmed = name.trim()
    if (!ready || !trimmed || trimmed === ready.settings.name) return Promise.resolve(false)
    return this.write(origin, organizationId, { name: trimmed })
  }

  /** An owner saves new host rules against the revision on screen. True when they were saved. */
  saveHostRules(origin: string, organizationId: string, hostRules: OrganizationHostRules): Promise<boolean> {
    const ready = this.ready(origin, organizationId)
    if (!ready || sameHostRules(ready.settings.hostRules, hostRules)) return Promise.resolve(false)
    return this.write(origin, organizationId, { hostRules, expectedRevision: ready.settings.hostRulesRevision })
  }

  private async write(origin: string, organizationId: string, patch: OrganizationSettingsPatchRequest): Promise<boolean> {
    const key = viewKey(origin, organizationId)
    const ready = this.ready(origin, organizationId)
    const requests = this.requests()
    if (!ready || ready.isSaving || !canManageOrganization(ready.settings)) return false
    if (!requests) {
      ready.saveError = organizationSettingsMessage({ kind: 'signed-out' })
      return false
    }
    ready.isSaving = true
    ready.saveError = null
    const result = await requests.organizationSettingsPatch(organizationId, patch)
    ready.isSaving = false
    if (result.kind === 'ok') {
      this.show(key, result.value)
      return true
    }
    // A conflict brings the other owner's settings: show them, and say why nothing was saved.
    const newer = result.kind === 'conflict' ? organizationSettingsResponseSchema.safeParse(result.document) : null
    if (newer?.success) this.show(key, newer.data)
    const current = this.ready(origin, organizationId)
    if (current) current.saveError = organizationSettingsMessage(result)
    return false
  }

  private show(key: string, settings: OrganizationSettingsResponse): void {
    const current = this.views.get(key)
    if (current?.status === 'ready') {
      current.settings = settings
      return
    }
    // A proxy, so a save in flight changes one field, not the view.
    const ready = $state<ReadyView>({ status: 'ready', settings, isSaving: false, saveError: null })
    this.views.set(key, ready)
  }

  private ready(origin: string, organizationId: string): ReadyView | null {
    const view = this.viewFor(origin, organizationId)
    return view?.status === 'ready' ? view : null
  }
}

function viewKey(origin: string, organizationId: string): string {
  return `${origin}\n${organizationId}`
}

function failedView(result: Exclude<PolicyApiResult<OrganizationSettingsResponse>, { kind: 'ok' }>): OrganizationSettingsView {
  switch (result.kind) {
    case 'forbidden': return { status: 'forbidden' }
    case 'signed-out': return { status: 'signed-out' }
    case 'offline': return { status: 'offline' }
    default: return { status: 'error', message: organizationSettingsMessage(result) ?? 'Solus Cloud did not answer.' }
  }
}

export const organizationSettingsStore = new OrganizationSettingsStore()
