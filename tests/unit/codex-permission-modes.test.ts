import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { PERMISSION_MODES } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let codex: typeof import('@solus/server/execution/agents/codex/codex-utils')

beforeAll(async () => {
  codex = await import('@solus/server/execution/agents/codex/codex-utils')
})

describe('Codex permission modes', () => {
  test('each mode maps to the Codex approval policy, reviewer, and sandbox', () => {
    const table = Object.fromEntries(PERMISSION_MODES.map((mode) => [
      mode,
      [codex.approvalPolicyFor(mode), codex.approvalsReviewerFor(mode), codex.sandboxPolicyFor(mode).type],
    ]))

    // WHY: Codex, not Solus, enforces these. Full access must stay the
    // unsandboxed, never-ask mode Solus shipped with; the others must reach
    // Codex's own sandbox and reviewer.
    expect(table).toEqual({
      supervised: ['untrusted', 'user', 'readOnly'],
      'accept-edits': ['on-request', 'user', 'workspaceWrite'],
      auto: ['on-request', 'auto_review', 'workspaceWrite'],
      'full-access': ['never', 'user', 'dangerFullAccess'],
      plan: ['never', 'user', 'readOnly'],
    })
  })
})
