import { describe, expect, test } from 'bun:test'
import {
  buildPullRequestAuthoringPrompt,
  fallbackPullRequestDraft,
  type PullRequestAuthoringContext,
} from '../../src/main/git/pull-request-authoring'

function context(overrides: Partial<PullRequestAuthoringContext> = {}): PullRequestAuthoringContext {
  return {
    baseBranch: 'main',
    headBranch: 'feature/pr-authoring',
    commitSummary: 'feat(git): author pull requests from the complete branch',
    diffStat: 'src/main/git.ts | 20 ++++++++++++++++++++',
    diffPatch: 'diff --git a/src/main/git.ts b/src/main/git.ts',
    template: null,
    ...overrides,
  }
}

describe('pull request authoring', () => {
  test('gives the writer complete branch context and strict testing rules', () => {
    const prompt = buildPullRequestAuthoringPrompt(
      context(),
      'Use Conventional Commits for the title.',
    )

    expect(prompt).toContain('Base branch: main')
    expect(prompt).toContain('Head branch: feature/pr-authoring')
    expect(prompt).toContain('feat(git): author pull requests from the complete branch')
    expect(prompt).toContain('src/main/git.ts | 20 ++++++++++++++++++++')
    expect(prompt).toContain('Do not claim tests passed')
    expect(prompt).toContain('Use Conventional Commits for the title.')
    expect(prompt).toContain('use Markdown headings "## Summary" and "## Testing"')
  })

  test('preserves the repository template and removes its comments in the fallback', () => {
    const template = [
      '## What changed',
      '<!-- Explain the change. -->',
      '',
      '## Verification',
      '- Not run',
    ].join('\n')
    const draft = fallbackPullRequestDraft(context({ template }))

    expect(draft.title).toBe('feat(git): author pull requests from the complete branch')
    expect(draft.body).toContain('## What changed')
    expect(draft.body).toContain('## Verification')
    expect(draft.body).not.toContain('<!--')
  })
})
