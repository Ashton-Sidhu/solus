import { describe, expect, test } from 'bun:test'
import {
  buildPullRequestAuthoringPrompt,
  fallbackPullRequestDraft,
  type PullRequestAuthoringContext,
} from '@solus/server/git/pull-request-authoring'

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
  test('gives the writer complete branch context and the house body rules', () => {
    const prompt = buildPullRequestAuthoringPrompt(
      context(),
      'Use Conventional Commits for the title.',
    )

    expect(prompt).toContain('Base branch: main')
    expect(prompt).toContain('Head branch: feature/pr-authoring')
    expect(prompt).toContain('feat(git): author pull requests from the complete branch')
    expect(prompt).toContain('src/main/git.ts | 20 ++++++++++++++++++++')
    expect(prompt).toContain('Use Conventional Commits for the title.')
    // The body is a demonstration, not a report on the author's own work.
    expect(prompt).toContain('dont include that you ran tests')
    expect(prompt).toContain('mermaid codeblock diagrams')
    expect(prompt).toContain('baseline from target branch, candidate from the PR')
    expect(prompt).toContain('only the final aggregate squash merge commit')
    expect(prompt).toContain('feel free to use code refs')
    expect(prompt).not.toContain('## Testing')
  })

  test('asks a repository template for a testing section, and never invents one', () => {
    const withTemplate = buildPullRequestAuthoringPrompt(context({ template: '## Verification' }))
    expect(withTemplate).toContain('only because the template asks for one')
    expect(withTemplate).not.toContain('mermaid codeblock diagrams')
  })

  test('the fallback body reports the change without a testing section', () => {
    const draft = fallbackPullRequestDraft(context())

    expect(draft.body).toContain('## Summary')
    expect(draft.body).toContain('- src/main/git.ts | 20 ++++++++++++++++++++')
    expect(draft.body).not.toContain('Testing')
    expect(draft.body).not.toContain('Not run')
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
