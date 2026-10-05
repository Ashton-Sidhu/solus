import type { OrganizationSettingsResult } from '@solus/client-core/settings-requests'
import type { OrganizationSettingsClient, OrganizationSettingsWriteResult } from '@solus/client-core/settings-sync'
import type { OrganizationSettings, OrganizationSettingsResponse } from '@solus/contracts/settings'
import { Listeners } from '../../lib/listeners'

/**
 * Organization settings on this device (plans/018 §7): the settings of one
 * organization (today only Sync all Insights), read from the account plane,
 * and an owner's draft of them. Members read; only `canManageSettings` edits.
 * A save is online and immediate against the revision the draft started from,
 * never queued: a conflict, a lost permission, or a refusal shows at once and
 * keeps the draft.
 */

export type OrganizationSettingsView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | {
    kind: 'loaded'
    settings: OrganizationSettingsResponse
    /** The owner's unsaved settings; null when nothing is changed. */
    draft: OrganizationSettingsDraft | null
    saving: boolean
    /** Someone saved first: `settings` now holds their values and the draft stays for a deliberate second save. */
    conflict: boolean
    /** The last refused save, in words. */
    saveError: string | null
  }

export type OrganizationSettingsDraft = OrganizationSettings

const IDLE = { kind: 'idle' } as const

export class OrganizationSettingsStore {
  readonly changes = new Listeners()
  private readonly views = new Map<string, OrganizationSettingsView>()
  /** Grows when the account changes: an answer for the previous account is dropped. */
  private generation = 0

  constructor(private readonly client: OrganizationSettingsClient) {}

  viewOf = (organizationId: string): OrganizationSettingsView => this.views.get(organizationId) ?? IDLE

  /** A different account sees nothing of the previous one's organizations. */
  clear(): void {
    this.generation += 1
    this.views.clear()
    this.changes.notify()
  }

  async load(organizationId: string): Promise<void> {
    const generation = this.generation
    const before = this.viewOf(organizationId)
    if (before.kind !== 'loaded') this.set(organizationId, { kind: 'loading' })
    const result = await this.client.read(organizationId)
    if (generation !== this.generation) return
    if (result.kind === 'ok') {
      const current = this.viewOf(organizationId)
      // A refresh keeps an owner's draft; it never discards typing.
      const draft = current.kind === 'loaded' && result.settings.canManageSettings ? current.draft : null
      this.set(organizationId, { kind: 'loaded', settings: result.settings, draft, saving: false, conflict: false, saveError: null })
      return
    }
    // A refresh that fails keeps what was read, and says why.
    if (before.kind === 'loaded' && (result.kind === 'offline' || result.kind === 'error')) {
      this.set(organizationId, { ...before, saveError: result.kind === 'offline' ? 'Solus Cloud did not answer.' : result.message ?? result.code })
      return
    }
    this.set(organizationId, failureView(result))
  }

  /** Changes the owner's draft. Does nothing for a member. */
  edit(organizationId: string, change: Partial<OrganizationSettingsDraft>): void {
    const view = this.viewOf(organizationId)
    if (view.kind !== 'loaded' || !view.settings.canManageSettings || view.saving) return
    const draft = { ...(view.draft ?? view.settings.settings), ...change }
    const unchanged = Object.keys(changedSettings(view.settings.settings, draft)).length === 0
    this.set(organizationId, { ...view, draft: unchanged ? null : draft, saveError: null })
  }

  /** Drops the draft and shows the saved settings. */
  cancel(organizationId: string): void {
    const view = this.viewOf(organizationId)
    if (view.kind !== 'loaded' || view.saving) return
    this.set(organizationId, { ...view, draft: null, conflict: false, saveError: null })
  }

  /**
   * Saves the draft against the revision read. A conflict shows what the other
   * owner saved and keeps this draft; pressing Save again then writes over it
   * on purpose.
   */
  async save(organizationId: string): Promise<void> {
    const view = this.viewOf(organizationId)
    if (view.kind !== 'loaded' || !view.draft || view.saving || !view.settings.canManageSettings) return
    const generation = this.generation
    const { draft, settings } = view
    this.set(organizationId, { ...view, saving: true, saveError: null })
    const result = await this.client.save(organizationId, settings.revision, changedSettings(settings.settings, draft))
    if (generation !== this.generation) return
    if (result.kind !== 'ok') return this.saveFailed(organizationId, result, draft)
    this.set(organizationId, { kind: 'loaded', settings: result.settings, draft: null, saving: false, conflict: false, saveError: null })
  }

  private saveFailed(
    organizationId: string,
    result: Exclude<OrganizationSettingsWriteResult, { kind: 'ok' }>,
    draft: OrganizationSettingsDraft,
  ): void {
    const view = this.viewOf(organizationId)
    if (view.kind !== 'loaded') return
    const { settings } = view
    if (result.kind === 'conflict') {
      this.set(organizationId, { kind: 'loaded', settings: result.current, draft, saving: false, conflict: true, saveError: null })
      return
    }
    if (result.kind === 'forbidden') {
      // Permission went away: the draft cannot be saved by this person any more.
      this.set(organizationId, { kind: 'forbidden' })
      return
    }
    if (result.kind === 'signed-out') {
      this.set(organizationId, { kind: 'signed-out' })
      return
    }
    const message = result.kind === 'offline' ? 'Solus Cloud did not answer. Nothing was saved.'
      : result.kind === 'invalid' ? result.message
      : result.message ?? result.code
    this.set(organizationId, { kind: 'loaded', settings, draft, saving: false, conflict: false, saveError: message })
  }

  private set(organizationId: string, view: OrganizationSettingsView): void {
    this.views.set(organizationId, view)
    this.changes.notify()
  }
}

function failureView(result: Exclude<OrganizationSettingsResult, { kind: 'ok' }>): OrganizationSettingsView {
  if (result.kind === 'error') return { kind: 'error', message: result.message ?? result.code }
  if (result.kind === 'conflict') return { kind: 'error', message: 'The settings changed while they were read. Try again.' }
  return { kind: result.kind }
}

/** Only the settings the draft changed: an untouched setting is not rewritten. */
function changedSettings(saved: OrganizationSettings, draft: OrganizationSettingsDraft): Partial<OrganizationSettings> {
  return saved.syncAllInsights === draft.syncAllInsights ? {} : { syncAllInsights: draft.syncAllInsights }
}
