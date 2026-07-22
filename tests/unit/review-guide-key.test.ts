import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGuideByKey } from '../../src/main/review/ledger'
import { reviewGuideKeyForBase } from '../../src/shared/review'

describe('reviewGuideKeyForBase', () => {
  test('two real bases must never coalesce onto one cache entry', () => {
    const target = reviewGuideKeyForBase('solus__pr-42')
    const ownDelta = reviewGuideKeyForBase('solus__pr-42', 'abc123')
    const movedParent = reviewGuideKeyForBase('solus__pr-42', 'def456')

    expect(ownDelta).not.toBe(target)
    expect(movedParent).not.toBe(ownDelta)
  })

  test('the same own-delta base keeps the stable cache identity', () => {
    expect(reviewGuideKeyForBase('solus__pr-42', 'abc123')).toBe(
      reviewGuideKeyForBase('solus__pr-42', 'abc123'),
    )
  })

  test('legacy guides recover their generation time from the cache file', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'solus-guide-metadata-'))
    const guideDir = join(repoRoot, '.solus', 'review')
    const guidePath = join(guideDir, 'solus__pr-42.json')
    const generatedAt = new Date('2026-07-19T14:30:00.000Z')
    try {
      await mkdir(guideDir, { recursive: true })
      await writeFile(guidePath, JSON.stringify({
        version: 1,
        key: 'solus__pr-42',
        headSha: 'abc123',
        baseSha: 'def456',
        title: 'Review guide',
        summary: 'Legacy cached guide',
        sections: [],
      }))
      await utimes(guidePath, generatedAt, generatedAt)

      const guide = await readGuideByKey(repoRoot, 'solus__pr-42')

      expect(guide?.generatedAt).toBe(generatedAt.toISOString())
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
