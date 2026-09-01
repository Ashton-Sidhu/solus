import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let resolveAutomationCwd: typeof import('@solus/server/automations/automation-cwd')['resolveAutomationCwd']

beforeAll(async () => {
  ;({ resolveAutomationCwd } = await import('@solus/server/automations/automation-cwd'))
})

describe('automation cwd', () => {
  test('preserves the exact cwd selected by the user', () => {
    expect(
      resolveAutomationCwd(
        '/workspace/project/.git/solus/worktrees/chosen',
        '/workspace/project/.git/solus/worktrees/active',
      ),
    ).toBe('/workspace/project/.git/solus/worktrees/chosen')
  })

  test('uses the project root only when cwd is omitted', () => {
    expect(
      resolveAutomationCwd(
        undefined,
        '/workspace/project/.git/solus/worktrees/active',
      ),
    ).toBe('/workspace/project')
  })
})
