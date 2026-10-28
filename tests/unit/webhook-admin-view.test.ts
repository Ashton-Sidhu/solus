import { afterAll, describe, expect, test } from 'bun:test'
import type { WebhookAdminEntry, WebhookAdminError, WebhookAdminList, WebhookAdminOutcome, WebhookAdminRef } from '@solus/contracts/webhook-admin'
import {
  chosenAdminOrganization,
  webhookAdminRefusalText,
  webhookAdminRow,
  webhookAdminRows,
} from '@solus/workspace-ui/components/webhooks/lib/webhook-admin-view'
import { EMPTY_WEBHOOKS_VIEW, parseWebhooksView, serializeWebhooksView } from '@solus/workspace-ui/components/webhooks/lib/webhooks-view'
import type { WebhookAdminApi } from '@solus/workspace-ui/contexts/webhooks/webhook-admin-api'
import { SvelteRunes } from './helpers/svelte-runes'

// docs/plans/webhooks.md §2.7 and §4: organization admins see the organization
// webhooks of all members, read from the Solus API, and can pause and resume
// them. An admin pause is apart from the owner's switch, and only an admin can
// end it. A refusal or a Solus API that does not answer is never a blank list.

function entry(patch: Partial<WebhookAdminEntry>): WebhookAdminEntry {
  return {
    hostId: 'host-a',
    hostLabel: 'Build box',
    webhookId: 'w1',
    name: 'GitHub CI',
    ownerUserId: 'user-1',
    ownerName: 'Ada',
    projectName: 'app',
    urlMode: 'cloud',
    state: 'active',
    actionTypes: ['start_session'],
    adminPause: null,
    lastDelivery: null,
    deliveriesLast24Hours: 0,
    ...patch,
  }
}

describe('the Organization view rows', () => {
  test('an admin pause wins over the owner state and offers Resume', () => {
    const row = webhookAdminRow('org-1', entry({ state: 'paused', adminPause: { pausedByUserId: 'admin', pausedAt: 1 } }))
    expect(row.stateLabel).toBe('Paused by organization admin')
    expect(row.action).toBe('resume')
    expect(row.ref).toEqual({ organizationId: 'org-1', hostId: 'host-a', webhookId: 'w1' })
  })

  test('an owner pause is not an admin pause: the admin can still pause it', () => {
    const row = webhookAdminRow('org-1', entry({ state: 'paused' }))
    expect(row.stateLabel).toBe('Paused by owner')
    expect(row.action).toBe('pause')
    expect(webhookAdminRow('org-1', entry({})).stateLabel).toBe('Active')
  })

  test('the owner shows by name, else by account id', () => {
    expect(webhookAdminRow('org-1', entry({ ownerName: null })).owner).toBe('user-1')
    expect(webhookAdminRow('org-1', entry({})).owner).toBe('Ada')
  })

  test('the last delivery and action types read as words; an unknown value shows as it is', () => {
    const row = webhookAdminRow('org-1', entry({
      actionTypes: ['start_session', 'run_automation', 'start_session', 'later_type'],
      lastDelivery: { deliveryId: 'd1', receivedAt: 5, outcome: 'partial', actionStatuses: ['started', 'failed'] },
      deliveriesLast24Hours: 3,
    }))
    expect(row.actionTypes).toBe('Start session, Run automation, later_type')
    expect(row.lastDelivery).toEqual({ outcome: 'Partly failed', isFailing: true, at: 5 })
    expect(row.deliveries24h).toBe(3)
    expect(webhookAdminRow('org-1', entry({ lastDelivery: { deliveryId: 'd', receivedAt: 1, outcome: 'new_outcome', actionStatuses: [] } })).lastDelivery?.outcome).toBe('new_outcome')
  })

  test('two hosts can hold the same webhook id: each row has its own key', () => {
    const rows = webhookAdminRows('org-1', [entry({ hostId: 'host-b', hostLabel: 'Laptop' }), entry({})])
    expect(rows.map((row) => row.hostLabel)).toEqual(['Build box', 'Laptop'])
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })

  test('each refusal has its own text', () => {
    expect(webhookAdminRefusalText('not_organization_admin')).toBe('Only an organization admin can see this view.')
    expect(webhookAdminRefusalText('host_not_of_organization')).toBe('That host does not deliver to this organization.')
  })
})

describe('the view in the page URL', () => {
  test('the Organization view and its organization survive a link', () => {
    const view = { ...EMPTY_WEBHOOKS_VIEW, scope: 'organization' as const, adminOrganization: 'org-2' }
    expect(parseWebhooksView(serializeWebhooksView(view))).toEqual(view)
    expect(parseWebhooksView('view=other').scope).toBe('hosts')
    expect(serializeWebhooksView(EMPTY_WEBHOOKS_VIEW)).toBe('')
  })

  test('the organization is the linked one when the person is a member, else the window one, else the first', () => {
    expect(chosenAdminOrganization(['org-1', 'org-2'], 'org-2', 'org-1')).toBe('org-2')
    expect(chosenAdminOrganization(['org-1', 'org-2'], 'org-9', 'org-2')).toBe('org-2')
    expect(chosenAdminOrganization(['org-1', 'org-2'], null, null)).toBe('org-1')
    expect(chosenAdminOrganization([], 'org-1', 'org-1')).toBeNull()
  })
})

// The store runs on Svelte's real client runtime, as in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const file = SvelteRunes.file
const { WebhookAdminStore }: typeof import('@solus/workspace-ui/contexts/webhooks/webhook-admin.store.svelte') = await import(
  runes.source('webhook-admin-store', 'packages/workspace-ui/src/contexts/webhooks/webhook-admin.store.svelte.ts', {
    'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
    '../../components/webhooks/lib/webhook-admin-view': file('packages/workspace-ui/src/components/webhooks/lib/webhook-admin-view.ts'),
    './webhook-admin-api': runes.module('webhook-admin-api', 'export const reachWebhookAdmin = () => { throw new Error("not in a test") }'),
  })
)

type ListAnswer = WebhookAdminOutcome<WebhookAdminList> | Error
type ActionAnswer = WebhookAdminOutcome<null> | Error

/** A fake Solus API that answers from queues; an `Error` is a call that throws. */
function solusApi(lists: ListAnswer[], actions: ActionAnswer[] = []) {
  const calls: string[] = []
  const answer = <T>(value: T | Error): Promise<T> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value))
  const api: WebhookAdminApi = {
    webhookAdminList: (organizationId) => { calls.push(`list ${organizationId}`); return answer(lists.shift()!) },
    webhookAdminPause: (ref) => { calls.push(`pause ${ref.webhookId}`); return answer(actions.shift()!) },
    webhookAdminResume: (ref) => { calls.push(`resume ${ref.webhookId}`); return answer(actions.shift()!) },
  }
  return { calls, store: new WebhookAdminStore(async () => api) }
}

const list = (webhooks: WebhookAdminEntry[]): WebhookAdminOutcome<WebhookAdminList> => ({ ok: true, value: { organizationId: 'org-1', webhooks } })
const refused = (error: WebhookAdminError) => ({ ok: false as const, error })
const ref: WebhookAdminRef = { organizationId: 'org-1', hostId: 'host-a', webhookId: 'w1' }

describe('the admin list store', () => {
  test('a list loads; an empty answer is loaded, not an error', async () => {
    const { store } = solusApi([list([entry({})]), list([])])
    const loading = store.load('org-1')
    expect(store.viewFor('org-1')).toEqual({ kind: 'loading' })
    await loading
    expect(store.viewFor('org-1')).toEqual({ kind: 'loaded', webhooks: [entry({})] })
    await store.load('org-1')
    expect(store.viewFor('org-1')).toEqual({ kind: 'loaded', webhooks: [] })
  })

  test('a refusal and a thrown call are states, never an empty list', async () => {
    const { store } = solusApi([refused('not_organization_admin'), new Error('not connected')])
    await store.load('org-1')
    expect(store.viewFor('org-1')).toEqual({ kind: 'refused', error: 'not_organization_admin' })
    await store.load('org-1')
    expect(store.viewFor('org-1')).toEqual({ kind: 'failed' })
  })

  test('an older answer does not replace a newer one', async () => {
    let releaseFirst!: (value: WebhookAdminOutcome<WebhookAdminList>) => void
    const answers = [new Promise<WebhookAdminOutcome<WebhookAdminList>>((resolve) => { releaseFirst = resolve }), Promise.resolve(list([entry({ name: 'New' })]))]
    const store = new WebhookAdminStore(async () => ({
      webhookAdminList: () => answers.shift()!,
      webhookAdminPause: async () => ({ ok: true, value: null }),
      webhookAdminResume: async () => ({ ok: true, value: null }),
    }))
    const first = store.load('org-1')
    await store.load('org-1')
    releaseFirst(list([entry({ name: 'Old' })]))
    await first
    const view = store.viewFor('org-1')
    expect(view?.kind === 'loaded' ? view.webhooks[0]?.name : null).toBe('New')
  })

  test('Pause calls the Solus API, then reads the list again', async () => {
    const paused = entry({ adminPause: { pausedByUserId: 'admin', pausedAt: 2 } })
    const { store, calls } = solusApi([list([paused])], [{ ok: true, value: null }])
    await store.setPaused(ref, true)
    expect(calls).toEqual(['pause w1', 'list org-1'])
    expect(store.actionFor(ref)).toBeNull()
    expect(store.viewFor('org-1')).toEqual({ kind: 'loaded', webhooks: [paused] })
  })

  test('a refused or failed Resume stays on its row, and the list is read again', async () => {
    const { store, calls } = solusApi([list([entry({})]), list([entry({})]), list([entry({})])], [
      refused('host_not_of_organization'),
      new Error('older service'),
      { ok: true, value: null },
    ])
    await store.setPaused(ref, false)
    expect(store.actionFor(ref)).toEqual({ kind: 'refused', error: 'host_not_of_organization' })
    await store.setPaused(ref, false)
    expect(store.actionFor(ref)).toEqual({ kind: 'failed' })
    await store.setPaused(ref, false)
    expect(store.actionFor(ref)).toBeNull()
    expect(calls).toEqual(['resume w1', 'list org-1', 'resume w1', 'list org-1', 'resume w1', 'list org-1'])
  })
})
