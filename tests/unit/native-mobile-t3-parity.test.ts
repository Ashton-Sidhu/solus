import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

describe('native thread header (T3 parity)', () => {
  test('without a favicon the title and subtitle are UIKit\'s own strings, so the bar bounds and truncates them', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    expect(header).toContain('const customTitle = Boolean(faviconRoot && subtitle && Platform.OS === "ios");')
    expect(header).toMatch(/headerTitle: customTitle\s*\?[\s\S]*?: props\.title,/)
    expect(header).toContain('unstable_headerSubtitle: customTitle ? undefined : subtitle')
    expect(header).toContain('headerBackVisible: canGoBack')
  })

  test('a project thread shows its favicon beside the project name, in a title view as wide as the space between the bar items', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    // A custom title view keeps its own size, so it is bounded by the column, Back, and the action group.
    expect(header).toContain('props.columnWidth - BACK_ITEM_WIDTH - ACTION_GROUP_INSET - actions.length * HEADER_ACTION_WIDTH')
    expect(header).toMatch(/<View style=\{\{ width: Math\.max\(titleWidth, 0\) \}\}[\s\S]*?\{favicon\(13\)\}[\s\S]*?\{subtitle\}/)
    // Android draws its own app bar and puts the favicon before the subtitle there.
    expect(header).toContain('subtitleLeading: favicon(13)')
  })

  test('the thread header asks for one shared group, as T3 sets sharesBackground', () => {
    expect(read('src/features/threads/ThreadRouteScreen.tsx')).toMatch(/actions=\{header\.actions\}\s+groupActions/)
    expect(read('src/components/ScreenHeader.tsx')).toContain('separateBackground={!props.groupActions}')
  })
})

describe('native typography (T3 parity)', () => {
  test('bold is T3 bold (DM Sans Bold is 700) in classes and in markdown', () => {
    expect(read('global.css')).toMatch(/@utility font-t3-bold \{\s*font-family: var\(--font-bold\);\s*font-weight: 700;/)
    // Markdown uses T3's bundled DM Sans faces, one font per weight, so bold is the Bold face itself.
    expect(read('app.json')).toContain('@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf')
    const style = read('src/lib/nativeMarkdownTextStyle.ts')
    expect(style).toContain('bold: "DMSans-Bold"')
    expect(style).toContain('headingFontFamily: MARKDOWN_FONTS.bold')
    expect(style).toContain('boldFontFamily: MARKDOWN_FONTS.bold')
    // Each face is one weight (nativeMarkdownTextStyle.ts), so the renderer asks for no weight on top of it.
    const enriched = read('src/native/EnrichedMarkdownText.tsx')
    expect(enriched).toContain('strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" }')
    expect(enriched).toMatch(/fontFamily: style\.headingFontFamily,\s*fontSize,/)
  })

  test('user bubble and composer geometry follow T3', () => {
    expect(read('src/features/threads/ThreadFeed.tsx')).toContain('rounded-[20px] px-3.5 py-2.5')
    expect(read('src/features/threads/ThreadComposer.tsx')).toContain('borderRadius: 26,')
    expect(read('src/features/threads/NewTaskRouteScreen.tsx')).toContain('borderRadius: 26,')
  })
})

describe('native session settings sheet (T3 parity)', () => {
  // A native stack screen inside a React Native Modal adds its own touch handler
  // beside the Modal's, so every tap arrives twice and the press is cancelled:
  // no model, provider, or option row in the picker could be chosen.
  test('the picker is a root form-sheet route, not a stack inside a React Native Modal', () => {
    const sheet = read('src/features/threads/ThreadSettingsSheet.tsx')
    expect(sheet).not.toMatch(/<Modal\b/)
    expect(sheet).not.toContain('NavigationIndependentTree')
    expect(sheet).toContain('export function ThreadSettingsRouteScreen')

    const root = read('src/navigation/RootNavigator.tsx')
    expect(root).toMatch(/name="ThreadSettings"\s*component=\{ThreadSettingsRouteScreen\}/)
  })

  test('the thread composer and the new-task draft open the same route', () => {
    for (const caller of ['src/features/threads/ThreadComposer.tsx', 'src/features/threads/NewTaskRouteScreen.tsx']) {
      const source = read(caller)
      expect(source).toContain('navigation.navigate("ThreadSettings"')
      expect(source).not.toContain('<ThreadSettingsSheet')
    }
  })
})
