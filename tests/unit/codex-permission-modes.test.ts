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

  test('the session folders are writable roots only where the sandbox has a workspace', () => {
    // WHY: docs/plans/codebases.md §6. A session works in several folders. In
    // the workspace sandbox Codex refuses a write outside its roots, so the
    // session folders must be roots there. A read-only mode must not get a
    // writable folder, and full access has no sandbox to give roots to.
    const roots = ['/Users/me/shop/web', '/Users/me/libs/ui']
    const policies = Object.fromEntries(PERMISSION_MODES.map((mode) => [mode, codex.sandboxPolicyFor(mode, roots)]))

    expect(policies).toEqual({
      supervised: { type: 'readOnly', networkAccess: false },
      'accept-edits': { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      auto: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      'full-access': { type: 'dangerFullAccess' },
      plan: { type: 'readOnly', networkAccess: true },
    })
    // A session with one working directory keeps the policy it had.
    expect(codex.sandboxPolicyFor('auto')).toEqual({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
  })
})
