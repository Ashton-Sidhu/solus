import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../../apps/client/src/components/MobilePlusMenu.svelte', import.meta.url),
  'utf8',
)

describe('mobile file attachment picker', () => {
  it('opens from a file input inside the tapped label', () => {
    // Mobile Safari only permits a file picker from the active tap. An async
    // capability check followed by input.click() loses that activation.
    const labelStart = source.indexOf('<label\n          class="{HERO_CARD}')
    const inputStart = source.indexOf('<input\n            class="sr-only"', labelStart)
    const labelEnd = source.indexOf('</label>', labelStart)

    expect(labelStart).toBeGreaterThan(-1)
    expect(inputStart).toBeGreaterThan(labelStart)
    expect(inputStart).toBeLessThan(labelEnd)
    expect(source.slice(labelStart, labelEnd)).toContain('type="file"')
    expect(source.slice(labelStart, labelEnd)).toContain('multiple')
  })

  it('uploads to the composer that opened the sheet', () => {
    expect(source).toContain('void onAttachFiles(files, composerSourceId)')
  })
})
