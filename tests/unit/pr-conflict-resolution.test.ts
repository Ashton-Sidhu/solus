import { describe, expect, test } from 'bun:test'
import { buildConflictResolutionPrompt } from '../../src/renderer/lib/pr-conflict-resolution'

describe('individual PR conflict resolution', () => {
  test('hands the resolver the prepared merge and leaves final PR merging to the user', () => {
    const prompt = buildConflictResolutionPrompt({
      number: 42,
      title: 'Keep sessions alive',
      baseRef: 'main',
      headRef: 'feature/sessions',
      conflictFiles: ['src/session.ts'],
    })

    expect(prompt).toContain('origin/main')
    expect(prompt).toContain('src/session.ts')
    expect(prompt).toContain('git commit --no-edit')
    expect(prompt).toContain('git push origin HEAD:refs/heads/feature/sessions')
    expect(prompt).toContain('Do not merge the pull request itself')
  })
})
