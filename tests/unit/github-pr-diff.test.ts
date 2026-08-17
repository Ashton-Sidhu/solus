import { describe, expect, test } from 'bun:test'
import {
  GitHubProvider,
  githubComparedHeadSha,
  githubFilesToUnifiedPatch,
} from '../../src/main/providers/github/provider'
import type { GitHubAuth } from '../../src/main/providers/github/auth'
import type { GitHubClient } from '../../src/main/providers/github/octokit'
import type { PullRequestDetail, RepoRef } from '../../src/shared/providers'

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

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
const commitSha = 'a'.repeat(40)

const detail = {
  number: 7,
  baseSha: 'base-sha',
  headSha: 'head-sha',
  headRepo: { owner: 'acme', repo: 'app', isFork: false },
} as PullRequestDetail

interface RecordedContentRead {
  owner: string
  path: string
  ref: string
}

/** The provider with its network seams replaced: `client()` yields a scripted
 *  REST surface, and the PR lookups return fixed revisions. */
class ScriptedGitHubProvider extends GitHubProvider {
  listFilesCalls = 0
  commitDiffReads: Array<{ ref: string; page: number }> = []
  contentReads: RecordedContentRead[] = []

  constructor(private readonly commitFilesLink?: string) {
    super({} as GitHubAuth)
  }

  protected override client(): Promise<GitHubClient> {
    const rest = {
      pulls: {
        listFiles: async () => {
          this.listFilesCalls++
          return { data: [], headers: {} }
        },
      },
      repos: {
        getCommit: async (params: { ref: string; page: number }) => {
          this.commitDiffReads.push({ ref: params.ref, page: params.page })
          return {
            data: {
              files: [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }],
            },
            headers: { link: this.commitFilesLink },
          }
        },
        getContent: async (params: { owner: string; path: string; ref: string }) => {
          this.contentReads.push({ owner: params.owner, path: params.path, ref: params.ref })
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(`${params.ref}:${params.path}`).toString('base64'),
            },
          }
        },
      },
      git: {
        getCommit: async () => ({ data: { parents: [{ sha: 'parent-sha' }] } }),
      },
    }
    return Promise.resolve({ rest } as unknown as GitHubClient)
  }

  override async getPullRequest(): Promise<PullRequestDetail> {
    return detail
  }

  override async getPullRequestDiffBase(): Promise<string> {
    return 'base-sha'
  }
}

describe('GitHub commit-scoped pull request diff', () => {
  test('serves a commit sha from the commit endpoint, not the PR file list', async () => {
    // WHY: clicking a commit must show that commit's own changes. The PR files
    // endpoint can only describe the whole change.
    const provider = new ScriptedGitHubProvider('<https://api.github.com/next>; rel="next"')
    const slice = await provider.getPullRequestDiff(repo, {
      number: 7,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      commitSha,
    })

    expect(provider.listFilesCalls).toBe(0)
    expect(provider.commitDiffReads).toEqual([{ ref: commitSha, page: 1 }])
    expect(slice.patch).toContain('diff --git a/src/a.ts b/src/a.ts')
    // Commit file lists page like PR file lists; the cursor must keep walking.
    expect(slice.nextCursor).toBe('2')
  })

  test('rejects a scope that is not a commit sha', async () => {
    // WHY: the value is spliced into an API path; only a real sha may travel.
    const provider = new ScriptedGitHubProvider()
    await expect(provider.getPullRequestDiff(repo, {
      number: 7,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      commitSha: 'feature/branch',
    })).rejects.toThrow('Invalid pull request commit.')
    expect(provider.commitDiffReads).toHaveLength(0)
  })

  test('expands commit-scoped file context against the commit parent, not the PR base', async () => {
    // WHY: a commit's old side is its parent. Reading the PR base would render
    // expanded context lines that never matched this commit's patch.
    const provider = new ScriptedGitHubProvider()
    const contents = await provider.getPullRequestDiffFileContents(repo, {
      number: 7,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      commitSha,
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      changeType: 'change',
    })

    expect(provider.contentReads).toEqual([
      { owner: 'acme', path: 'src/a.ts', ref: 'parent-sha' },
      { owner: 'acme', path: 'src/a.ts', ref: commitSha },
    ])
    expect(contents.oldContents).toBe('parent-sha:src/a.ts')
    expect(contents.newContents).toBe(`${commitSha}:src/a.ts`)
  })
})
