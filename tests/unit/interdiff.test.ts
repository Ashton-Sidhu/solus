import { describe, expect, test } from 'bun:test'
import { parsePatchFiles } from '@pierre/diffs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorReviewThreads,
  checkpointState,
  comparePatchSets,
} from '../../src/main/git/interdiff'
import { readReviewCheckpoint, writeReviewCheckpoint } from '../../src/main/review/checkpoints'
import type { ReviewThread } from '../../src/shared/providers'
import type { InterdiffHunk, ReviewCheckpoint } from '../../src/shared/git-types'

function patch(filePath: string, index: string, hunk: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `index ${index} 100644`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    hunk,
    '',
  ].join('\n')
}

function thread(id: string, filePath: string, line: number): ReviewThread {
  return {
    id,
    filePath,
    line,
    side: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    comments: [{ id: `${id}-comment`, author: 'reviewer', body: 'Please fix this', createdAt: '2026-07-14T12:00:00.000Z' }],
  }
}

describe('PR patch-set interdiff', () => {
  test('a rebase with identical patch content stays empty so a second pass does not explode into the whole PR', () => {
    const before = patch('src/auth.ts', '1111111..2222222', '@@ -10,2 +10,3 @@\n context\n+validate()\n return')
    const rebased = patch('src/auth.ts', 'aaaaaaa..bbbbbbb', '@@ -42,2 +42,3 @@\n context\n+validate()\n return')

    expect(comparePatchSets(before, rebased)).toEqual({ patch: '', hunks: [] })
  })

  test('a new commit contributes only its changed file and hunk, not already-reviewed files', () => {
    const reviewed = patch('src/stable.ts', '1111111..2222222', '@@ -1 +1,2 @@\n keep\n+reviewed')
    const current = reviewed + patch('src/follow-up.ts', '3333333..4444444', '@@ -8 +8,2 @@\n existing\n+addressed')

    const delta = comparePatchSets(reviewed, current)

    expect(delta.patch).toContain('diff --git a/src/follow-up.ts b/src/follow-up.ts')
    expect(delta.patch).toContain('+addressed')
    expect(delta.patch).not.toContain('src/stable.ts')
    expect(delta.hunks.map((hunk) => hunk.filePath)).toEqual(['src/follow-up.ts'])
    expect(parsePatchFiles(delta.patch).flatMap((parsed) => parsed.files).map((file) => file.name)).toEqual([
      'src/follow-up.ts',
    ])
  })

  test('a different reviewed base invalidates the checkpoint even when the head also moved', () => {
    const checkpoint: ReviewCheckpoint = {
      prNumber: 42,
      headSha: 'old-head',
      base: 'old-base',
      reviewedAt: '2026-07-14T12:00:00.000Z',
    }

    expect(checkpointState(checkpoint, 'new-head', 'new-base')).toEqual({
      state: 'invalid',
      invalidReason: 'base-changed',
    })
  })
})

describe('review checkpoints', () => {
  test('stores one per-PR latest checkpoint without losing other PRs', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'solus-review-checkpoint-'))
    try {
      const first: ReviewCheckpoint = {
        prNumber: 7,
        headSha: 'head-one',
        base: 'base-one',
        reviewedAt: '2026-07-14T12:00:00.000Z',
      }
      await writeReviewCheckpoint(repoRoot, first)
      await writeReviewCheckpoint(repoRoot, { ...first, headSha: 'head-two' })
      await writeReviewCheckpoint(repoRoot, { ...first, prNumber: 8, headSha: 'other-pr' })

      expect(await readReviewCheckpoint(repoRoot, 7)).toEqual({ ...first, headSha: 'head-two' })
      expect(await readReviewCheckpoint(repoRoot, 8)).toEqual({ ...first, prNumber: 8, headSha: 'other-pr' })
      const stored = JSON.parse(await readFile(join(repoRoot, '.solus/review/checkpoints.json'), 'utf8'))
      expect(Object.keys(stored).sort()).toEqual(['7', '8'])
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('prior comment anchoring', () => {
  test('matches by same-file proximity and leaves unrelated comments visibly unmatched', () => {
    const hunk: InterdiffHunk = {
      id: 'src/auth.ts:40:40',
      filePath: 'src/auth.ts',
      oldStart: 40,
      oldLines: 5,
      newStart: 40,
      newLines: 7,
      patch: '@@ -40,5 +40,7 @@',
    }
    const matches = anchorReviewThreads([
      thread('near', 'src/auth.ts', 48),
      thread('far', 'src/auth.ts', 100),
      thread('other-file', 'src/api.ts', 42),
    ], [hunk])

    expect(matches[0].hunk?.id).toBe(hunk.id)
    expect(matches.filter((match) => match.hunk === null).map((match) => match.thread.id)).toEqual([
      'far',
      'other-file',
    ])
  })
})
