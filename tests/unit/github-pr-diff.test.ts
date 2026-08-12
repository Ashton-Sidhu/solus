import { describe, expect, test } from 'bun:test'
import {
  githubComparedHeadSha,
  githubFilesToUnifiedPatch,
} from '../../src/main/providers/github/provider'

describe('GitHub pull request diff conversion', () => {
  test('reads the compared head without a non-existent head_commit field', () => {
    // WHY: GitHub's compare API returns `commits` and `merge_base_commit`, not
    // `head_commit`. Opening any ahead PR must not dereference a missing field.
    expect(githubComparedHeadSha({
      commits: [{ sha: 'first' }, { sha: 'head' }],
      merge_base_commit: { sha: 'base' },
    })).toBe('head')

    // A head that is equal to or behind the base has no ahead commits.
    expect(githubComparedHeadSha({
      commits: [],
      merge_base_commit: { sha: 'head' },
    })).toBe('head')
  })

  test('keeps every paged file as one complete unified patch', () => {
    // WHY: the renderer appends provider pages. A page boundary inside a file
    // would corrupt line anchors for inline review comments.
    const result = githubFilesToUnifiedPatch([
      {
        filename: 'src/new name.ts',
        previous_filename: 'src/old name.ts',
        status: 'renamed',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        filename: 'src/added.ts',
        status: 'added',
        patch: '@@ -0,0 +1 @@\n+added',
      },
    ])

    expect(result.truncated).toBe(false)
    expect(result.patch).toContain('diff --git "a/src/old name.ts" "b/src/new name.ts"')
    expect(result.patch).toContain('rename from src/old name.ts\nrename to src/new name.ts')
    expect(result.patch).toContain('--- /dev/null\n+++ b/src/added.ts')
    expect(result.patch.split('diff --git ')).toHaveLength(3)
  })

  test('keeps omitted host patches visible and reports incomplete context', () => {
    // WHY: GitHub omits patch text for binary and oversized files. Treating it
    // as an empty diff would silently hide part of the review.
    const result = githubFilesToUnifiedPatch([
      { filename: 'assets/image.png', status: 'modified' },
    ])

    expect(result.truncated).toBe(true)
    expect(result.patch).toContain('Binary files a/assets/image.png and b/assets/image.png differ')
  })

  test('represents a pure rename without marking the diff truncated', () => {
    const result = githubFilesToUnifiedPatch([
      {
        filename: 'src/current.ts',
        previous_filename: 'src/previous.ts',
        status: 'renamed',
      },
    ])

    expect(result.truncated).toBe(false)
    expect(result.patch).toContain('similarity index 100%')
  })
})
