import { describe, expect, test } from 'bun:test'
import { estimateReviewEffort } from '../../src/main/review/effort'
import type { EffortInput } from '../../src/shared/effort-types'

function input(
  fileStats: EffortInput['fileStats'],
  options: Partial<Pick<EffortInput, 'generatedPaths' | 'renamedPaths'>> = {},
): EffortInput {
  return {
    fileStats,
    generatedPaths: options.generatedPaths ?? [],
    renamedPaths: options.renamedPaths ?? [],
  }
}

describe('estimateReviewEffort', () => {
  test('marks lockfile-only dependency churn quick and explains why humans only need to confirm it', () => {
    const effort = estimateReviewEffort(input([
      { path: 'bun.lock', additions: 800, deletions: 650 },
    ], { generatedPaths: ['bun.lock'] }))

    expect(effort.band).toBe('quick')
    expect(effort.minutes).toBe(1)
    expect(effort.signals).toContain('lockfile only')
  })

  test('makes broad feature work involved and exposes its reading volume', () => {
    const effort = estimateReviewEffort(input(Array.from({ length: 40 }, (_, index) => ({
      path: `src/feature/file-${index}.ts`,
      additions: 8,
      deletions: 2,
    }))))

    expect(effort.band).toBe('involved')
    expect(effort.signals).toContain('40 files · 400 lines')
  })

  test('treats a pure path move as quick because there is no content to read', () => {
    const effort = estimateReviewEffort(input([
      { path: 'src/new-name.ts', additions: 0, deletions: 0 },
    ], { renamedPaths: ['src/new-name.ts'] }))

    expect(effort.band).toBe('quick')
    expect(effort.signals).toContain('rename only')
  })

  test('never calls an auth-path diff quick and tells the reviewer about the risk', () => {
    const effort = estimateReviewEffort(input([
      { path: 'src/auth/session.ts', additions: 4, deletions: 1 },
    ]))

    expect(effort.band).toBe('involved')
    expect(effort.signals).toContain('touches auth/')
    expect(effort.minutes).toBeGreaterThan(1)
  })
})
