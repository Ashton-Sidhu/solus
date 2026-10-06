import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

describe('native thread header (T3 parity)', () => {
  test('the title is UIKit\'s own string, so the bar bounds and truncates it before the actions', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    // A custom title view keeps its own size and is centred over the bar items.
    expect(header).not.toMatch(/headerTitle:\s*\(/)
    expect(header).toContain('headerTitle: props.title')
    expect(header).toContain('unstable_headerSubtitle: subtitle')
  })

  test('the favicon is a left bar item beside Back, without a glass background', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    expect(header).toMatch(/unstable_headerLeftItems: \(\) => \[\s*\{\s*type: "custom" as const/)
    expect(header).toContain('hidesSharedBackground: true')
    expect(header).toContain('headerBackVisible: canGoBack')
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
