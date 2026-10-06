import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { threadTitleMaxWidth } from '../../apps/mobile/src/lib/layout'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

describe('native thread header (T3 parity)', () => {
  test('grouped actions leave the title more room than a 44pt circle each', () => {
    // A 390pt phone with Back and three actions in one shared glass group.
    expect(threadTitleMaxWidth(390, 3, true)).toBe(390 - 32 - 52 - (16 + 40 * 3))
    expect(threadTitleMaxWidth(390, 3, true)).toBeGreaterThan(390 - 64 - 44 * 4)
    expect(threadTitleMaxWidth(100, 3, true)).toBe(0)
  })

  test('the thread header asks for one shared group, as T3 sets sharesBackground', () => {
    expect(read('src/features/threads/ThreadRouteScreen.tsx')).toMatch(/actions=\{header\.actions\}\s+groupActions/)
    expect(read('src/components/ScreenHeader.tsx')).toContain('separateBackground={!props.groupActions}')
  })
})

describe('native typography (T3 parity)', () => {
  test('bold is T3 bold (DM Sans Bold is 700) in classes and in markdown', () => {
    expect(read('global.css')).toMatch(/@utility font-t3-bold \{\s*font-family: var\(--font-bold\);\s*font-weight: 700;/)
    expect(read('src/lib/nativeMarkdownTextStyle.ts')).toContain('boldFontWeight: "700"')
  })

  test('user bubble and composer geometry follow T3', () => {
    expect(read('src/features/threads/ThreadFeed.tsx')).toContain('rounded-[20px] px-3.5 py-2.5')
    expect(read('src/features/threads/ThreadComposer.tsx')).toContain('borderRadius: 26,')
    expect(read('src/features/threads/NewTaskRouteScreen.tsx')).toContain('borderRadius: 26,')
  })
})
