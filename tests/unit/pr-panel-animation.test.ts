import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/prs/PrsPage.svelte'),
  'utf8',
)

describe('PR detail panel animation', () => {
  test('returns the list to full width while the panel exits', () => {
    // WHY: If the list switches directly from a fixed rail to flex sizing, its
    // expansion happens in one frame and makes the panel close look laggy.
    expect(source).toContain('transition-[width] duration-200')
    expect(source).toMatch(
      /splitList\s*\n\s*\? 'w-\[380px\]'\s*\n\s*: 'w-full'/,
    )
  })

  test('removes both close transitions when reduced motion is requested', () => {
    // WHY: The list and panel are one spatial transition, so reducing only one
    // side would leave an uneven layout shift.
    expect(source).toContain('motion-reduce:transition-none')
    expect(source).toContain('duration: reduceMotion ? 0 : 200')
  })
})
