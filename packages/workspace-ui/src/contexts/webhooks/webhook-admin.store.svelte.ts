import { SvelteMap } from 'svelte/reactivity'
import type { WebhookAdminEntry, WebhookAdminError, WebhookAdminRef } from '@solus/contracts/webhook-admin'
import { webhookAdminKey } from '../../components/webhooks/lib/webhook-admin-view'
import { reachWebhookAdmin, type WebhookAdminApi } from './webhook-admin-api'

/**
 * What one organization's admin list shows. `failed` is a call that threw: the
 * Solus API is not connected, or it is an older service without the methods.
 * An error is never shown as an empty list.
 */
export type WebhookAdminView =
  | { kind: 'loading' }
  | { kind: 'loaded'; webhooks: WebhookAdminEntry[] }
  | { kind: 'refused'; error: WebhookAdminError }
  | { kind: 'failed' }

/** A Pause or Resume of one row, while it runs or after it did not succeed. */
export type WebhookAdminActionState =
  | { kind: 'busy' }
  | { kind: 'refused'; error: WebhookAdminError }
  | { kind: 'failed' }

/**
 * The Organization view of Settings → Webhooks (docs/plans/webhooks.md §2.7, §4):
 * the organization webhooks of all members, read from the organization's Solus
 * API, one list for each organization. Pause and Resume read the list again.
 */
export class WebhookAdminStore {
  readonly views = new SvelteMap<string, WebhookAdminView>()
  readonly actions = new SvelteMap<string, WebhookAdminActionState>()
  /** Bumped by every read of an organization; an older answer does not land. */
  private readonly revisions = new Map<string, number>()

  constructor(private readonly reach: (organizationId: string) => Promise<WebhookAdminApi>) {}

  viewFor(organizationId: string): WebhookAdminView | null {
    return this.views.get(organizationId) ?? null
  }

  actionFor(ref: WebhookAdminRef): WebhookAdminActionState | null {
    return this.actions.get(webhookAdminKey(ref)) ?? null
  }

  /** A read again keeps the last list on screen until the new answer arrives. */
  async load(organizationId: string): Promise<void> {
    const revision = (this.revisions.get(organizationId) ?? 0) + 1
    this.revisions.set(organizationId, revision)
    if (this.views.get(organizationId)?.kind !== 'loaded') this.views.set(organizationId, { kind: 'loading' })
    let next: WebhookAdminView
    try {
      const outcome = await (await this.reach(organizationId)).webhookAdminList(organizationId)
      next = outcome.ok ? { kind: 'loaded', webhooks: outcome.value.webhooks } : { kind: 'refused', error: outcome.error }
    } catch (error) {
      console.error('webhook admin list failed', organizationId, error)
      next = { kind: 'failed' }
    }
    if (this.revisions.get(organizationId) !== revision) return
    this.views.set(organizationId, next)
  }

  /** An admin pause, or its end. A refusal or error stays on the row; the list is read again either way. */
  async setPaused(ref: WebhookAdminRef, paused: boolean): Promise<void> {
    const key = webhookAdminKey(ref)
    if (this.actions.get(key)?.kind === 'busy') return
    this.actions.set(key, { kind: 'busy' })
    try {
      const api = await this.reach(ref.organizationId)
      const outcome = paused ? await api.webhookAdminPause(ref) : await api.webhookAdminResume(ref)
      if (outcome.ok) this.actions.delete(key)
      else this.actions.set(key, { kind: 'refused', error: outcome.error })
    } catch (error) {
      console.error('webhook admin pause failed', ref, error)
      this.actions.set(key, { kind: 'failed' })
    }
    await this.load(ref.organizationId)
  }
}

export const webhookAdminStore = new WebhookAdminStore(reachWebhookAdmin)
