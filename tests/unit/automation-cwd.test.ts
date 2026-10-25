import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let resolveAutomationCwd: typeof import('@solus/server/execution/automations/automation-cwd')['resolveAutomationCwd']

beforeAll(async () => {
  ;({ resolveAutomationCwd } = await import('@solus/server/execution/automations/automation-cwd'))
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
