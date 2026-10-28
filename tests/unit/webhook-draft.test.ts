import { describe, expect, test } from 'bun:test'
import type { Webhook } from '@solus/contracts/webhooks'
import {
  actionsFromDraft,
  createInputFromDraft,
  draftFromWebhook,
  newWebhookDraft,
  parseHeaderLines,
  updateInputFromDraft,
  type WebhookDraft,
} from '@solus/workspace-ui/components/webhooks/lib/webhook-draft'

function savedWebhook(): Webhook {
  return {
    id: 'w1',
    organizationId: 'local',
    name: 'GitHub',
    enabled: true,
    pausedByAdmin: false,
    project: '/repo',
    verification: {
      scheme: 'hmac',
      algorithm: 'sha256',
      signedText: '{{body}}',
      signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
    },
    replayKey: '{{headers.x-github-delivery}}',
    actions: [{
      id: 'a1',
      type: 'start_session',
      enabled: true,
      filters: [{ path: 'body.action', op: 'in', values: ['opened', 'reopened'] }, { path: 'headers.x-github-event', op: 'exists' }],
      template: 'Review {{body.pull_request.html_url}}',
      agentProvider: 'claude-code',
      modelId: null,
      reasoningEffort: 'high',
      cwd: '/repo',
      useWorktree: true,
    }],
    urlMode: 'cloud',
    urlChanged: false,
    lostCount: 0,
    lostAt: null,
    lastDelivery: null,
    deliveries24h: 0,
    createdBy: { kind: 'system' },
    ownerKey: 'owner',
    createdAt: 0,
    updatedAt: 0,
  }
}

function newDraft(): WebhookDraft {
  const draft = newWebhookDraft(null, 'a1')
  draft.name = 'Hook'
  draft.verification.scheme = 'token'
  draft.verification.source = { kind: 'bearer', name: '', key: '', separator: '' }
  draft.actions[0] = { ...draft.actions[0], type: 'send_to_session', sessionId: 's1', template: 'x' }
  return draft
}

// The editor has plain fields with no defaults (docs/plans/webhooks.md §3.6):
// a save never sends a value the user did not choose.
describe('webhook editor draft', () => {
  test('a new draft chooses nothing for the user', () => {
    const draft = newWebhookDraft(null, 'a1')
    expect(draft.verification.scheme).toBe('')
    expect(draft.actions[0].type).toBe('')
    expect(createInputFromDraft({ ...draft, name: 'Hook' })).toEqual({ ok: false, error: 'Choose how Solus verifies requests.' })
  })

  test('a new webhook with a secret scheme needs a typed secret', () => {
    const draft = newDraft()
    expect(createInputFromDraft(draft)).toEqual({ ok: false, error: 'Enter the secret.' })
    draft.verification.secret = 's3cret'
    const input = createInputFromDraft(draft)
    expect(input.ok && input.value.verification).toEqual({ scheme: 'token', source: { kind: 'bearer' }, secret: 's3cret' })
  })

  test('an update without a secret keeps the saved one only for the same scheme', () => {
    const webhook = savedWebhook()
    const draft = draftFromWebhook(webhook)
    expect(draft.verification.secret).toBe('')
    const same = updateInputFromDraft(draft, webhook.verification.scheme)
    expect(same.ok && same.value.verification).toEqual(webhook.verification)
    expect(same.ok && same.value.verification && 'secret' in same.value.verification).toBe(false)

    draft.verification.scheme = 'standard_webhooks'
    expect(updateInputFromDraft(draft, webhook.verification.scheme)).toEqual({ ok: false, error: 'Enter the secret.' })
  })

  test('a saved webhook comes back unchanged through the draft', () => {
    const webhook = savedWebhook()
    const update = updateInputFromDraft(draftFromWebhook(webhook), 'hmac')
    expect(update.ok && update.value.actions).toEqual(webhook.actions)
    expect(update.ok && update.value.replayKey).toBe(webhook.replayKey)
  })

  test('an unverified webhook needs a reason of ten characters or more', () => {
    const draft = newDraft()
    draft.verification.scheme = 'none'
    draft.verification.reason = 'short'
    expect(createInputFromDraft(draft).ok).toBe(false)
    draft.verification.reason = 'Acme Pager accepts only a URL.'
    expect(createInputFromDraft(draft).ok).toBe(true)
  })

  test('an incomplete filter or action is refused, not dropped', () => {
    const draft = newDraft()
    draft.actions[0].filters.push({ path: 'body.action', op: '', value: '' })
    expect(actionsFromDraft(draft.actions)).toEqual({ ok: false, error: 'Action 1: complete each filter, or remove it.' })
    draft.actions[0].filters[0].op = 'equals'
    draft.actions[0].sessionId = ''
    expect(actionsFromDraft(draft.actions)).toEqual({ ok: false, error: 'Action 1: complete the type and its fields.' })
  })
})

describe('dry run headers', () => {
  test('one header for each line; a line without a name is ignored', () => {
    expect(parseHeaderLines('X-GitHub-Event: pull_request\n\nbad line\nAuthorization: Bearer a:b')).toEqual([
      ['X-GitHub-Event', 'pull_request'],
      ['Authorization', 'Bearer a:b'],
    ])
  })
})
