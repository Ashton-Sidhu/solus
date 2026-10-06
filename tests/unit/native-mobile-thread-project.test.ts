import { describe, expect, test } from 'bun:test'
import type { SessionRecord } from '@solus/contracts/types'
import {
  threadProjectFallbackTitle,
  threadProjectKey,
  threadProjectPath,
} from '../../apps/mobile/src/features/threads/threadListV2'
import type { SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'

// A Claude session lists the provider's encoded storage folder as its
// `projectPath`. The phone must name and group it by the real project, or the
// header reads "-Users-me-solus" and the project's favicon never matches.
function claudeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 's1',
    slug: null,
    firstMessage: null,
    lastTimestamp: '2026-10-05T00:00:00.000Z',
    size: 1,
    cwd: '/Users/me/solus',
    projectPath: '-Users-me-solus',
    ...overrides,
  } as SessionRecord
}

describe('native thread project', () => {
  test('a Claude session is named by its folder, not its storage key', () => {
    expect(threadProjectPath(claudeRecord())).toBe('/Users/me/solus')
    expect(threadProjectFallbackTitle(claudeRecord())).toBe('solus')
  })

  test('a worktree session belongs to the project it was cut from', () => {
    const record = claudeRecord({
      cwd: '/Users/me/solus/.git/solus/worktrees/solus-1234',
      projectPath: '-Users-me-solus--git-solus-worktrees-solus-1234',
    })
    expect(threadProjectPath(record)).toBe('/Users/me/solus')
  })

  test('the host’s project root wins over the working folder', () => {
    expect(threadProjectPath(claudeRecord({ cwd: '/Users/me/solus/apps/mobile', projectRoot: '/Users/me/solus' }))).toBe('/Users/me/solus')
  })

  test('a session matches the listed project by its real root', () => {
    const thread = { hostId: 'h1', record: claudeRecord() } as SolusThreadShell
    const listed = 'h1\u0000/Users/me/solus'
    expect(threadProjectKey(thread, new Set([listed]))).toBe(listed)
  })

  test('with no folder known, the stored name is all there is', () => {
    expect(threadProjectPath(claudeRecord({ cwd: '' }))).toBe('-Users-me-solus')
  })
})
