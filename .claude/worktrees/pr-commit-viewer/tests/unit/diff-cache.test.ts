import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearPatchMetadataCache,
  parsePatchMetadata,
  patchMetadataCacheStats,
} from '../../src/renderer/lib/diff'

afterEach(clearPatchMetadataCache)

describe('diff metadata cache retention', () => {
  test('does not retain an oversized patch as a renderer-lifetime map key', () => {
    clearPatchMetadataCache()
    parsePatchMetadata(`diff --git a/a b/a\n${'x'.repeat(300_000)}`)
    expect(patchMetadataCacheStats()).toEqual({ entries: 0, sourceBytes: 0 })
  })

  test('keeps ordinary patches within both cardinality and byte budgets', () => {
    clearPatchMetadataCache()
    for (let index = 0; index < 500; index++) {
      parsePatchMetadata(`diff --git a/${index} b/${index}\n--- a/${index}\n+++ b/${index}\n`)
    }
    const stats = patchMetadataCacheStats()
    expect(stats.entries).toBeLessThanOrEqual(400)
    expect(stats.sourceBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})
