import { describe, expect, mock, test } from 'bun:test'

describe('source-control writing policy', () => {
  test('uses recent commit subjects for repository-convention mode', async () => {
    mock.module('@solus/server/git/exec', () => ({
      runAsync: async () => [
        'fix(sessions): keep host selection stable',
        'Add source-control writing settings',
      ].join('\n'),
    }))
    const { resolveSourceControlWritingPolicy } = await import(
      '@solus/server/git/source-control-writing'
    )

    const policy = await resolveSourceControlWritingPolicy('/tmp/repo', {
      mode: 'repo_conventions',
      customInstructions: '',
      followPullRequestTemplate: false,
    })

    expect(policy.commitInstructions).toContain('fix(sessions): keep host selection stable')
    expect(policy.pullRequestInstructions).toContain('Add source-control writing settings')
    expect(policy.followPullRequestTemplate).toBe(false)
  })

  test('uses one custom policy for commit and pull-request writing', async () => {
    const { resolveSourceControlWritingPolicy } = await import(
      '@solus/server/git/source-control-writing'
    )
    const policy = await resolveSourceControlWritingPolicy('/tmp/repo', {
      mode: 'custom',
      customInstructions: 'Use imperative titles and include a Risks section.',
      followPullRequestTemplate: true,
    })

    expect(policy.commitInstructions).toBe('Use imperative titles and include a Risks section.')
    expect(policy.pullRequestInstructions).toBe(policy.commitInstructions)
    expect(policy.followPullRequestTemplate).toBe(true)
  })

  test('applies Conventional Commits to commits without forcing pull-request titles', async () => {
    const { resolveSourceControlWritingPolicy } = await import(
      '@solus/server/git/source-control-writing'
    )
    const policy = await resolveSourceControlWritingPolicy('/tmp/repo', {
      mode: 'conventional_commits',
      customInstructions: '',
      followPullRequestTemplate: true,
    })

    expect(policy.commitInstructions).toContain('Use Conventional Commits')
    expect(policy.pullRequestInstructions).toContain('Do not force Conventional Commit syntax')
  })
})
