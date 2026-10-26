// Adapted from T3 Code apps/mobile/scripts/generate-highlights.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  computeHighlightsData,
  generatedBanner,
  renderHighlightsData,
} from '../../apps/mobile/scripts/generate-highlights.mts'

const mobileRoot = resolve(import.meta.dir, '../../apps/mobile')

describe('generated highlights', () => {
  // Token and language IDs are the native build's ABI. Bumping
  // @pierre/highlights for web without regenerating would mislabel every
  // token on mobile. Regenerate with apps/mobile/scripts/generate-highlights.mts.
  test('come from the @pierre/highlights web uses', async () => {
    const data = await computeHighlightsData()
    const banner = `/* ${generatedBanner(data.source)} */`
    const firstLine = (path: string) => readFileSync(join(mobileRoot, path), 'utf8').split('\n', 1)[0]

    expect(readFileSync(join(mobileRoot, 'src/lib/highlights.generated.ts'), 'utf8')).toBe(renderHighlightsData(data))
    expect(firstLine('modules/solus-highlights/Vendor/highlights/highlights.c')).toBe(banner)
    expect(firstLine('modules/solus-highlights/Vendor/highlights/highlights.h')).toBe(banner)
  })
})
