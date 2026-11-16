import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

describe('native thread header (T3 parity)', () => {
  test('UIKit bounds the native title and subtitle between the bar items', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    expect(header).toContain('headerTitle: props.title')
    expect(header).toMatch(/unstable_headerSubtitle: props\.usesNativeHeaderGlass\s*\? props\.subtitle\s*: undefined/)
    expect(header).toContain('headerBackVisible: navigation.canGoBack()')
    expect(header).not.toContain('columnWidth')
  })

  test('Files stays in the header; browser and device previews stay above the composer', () => {
    const header = read('src/features/threads/useThreadHeaderOptions.tsx')
    expect(header).toContain('accessibilityLabel: "Open files"')
    expect(header).not.toContain('ellipsis')
    expect(header).not.toContain('globe')
    const route = read('src/features/threads/ThreadRouteScreen.tsx')
    expect(route).not.toContain('menus={header.menus}')
    expect(read('src/features/threads/ThreadDetailScreen.tsx')).toContain('useThreadViewers')
  })

  test('the header shares its action background and keeps iPad compose on the leading side', () => {
    expect(read('src/features/threads/ThreadRouteScreen.tsx')).toMatch(/actions=\{header\.actions\}\s+groupActions/)
    expect(read('src/features/threads/ThreadRouteScreen.tsx')).toMatch(/layout.usesSplitView \? \([\s\S]*?placement="left"[\s\S]*?onPress=\{header.onCompose\}/)
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
    expect(read('src/features/threads/ThreadUserMessageRow.tsx')).toContain('rounded-[20px] px-3.5 py-2.5')
    expect(read('src/features/threads/ThreadComposer.tsx')).toContain('borderRadius: 27,')
    expect(read('src/features/threads/NewTaskRouteScreen.tsx')).toContain('<ThreadComposer')
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
    const composer = read('src/features/threads/ThreadComposer.tsx')
    const draft = read('src/features/threads/NewTaskRouteScreen.tsx')
    expect(composer).toContain('navigation.navigate("ThreadSettings"')
    expect(draft).toContain('<ThreadComposer')
    expect(draft).not.toContain('<ThreadSettingsSheet')
    expect(composer).not.toContain('<ThreadSettingsSheet')
  })
})
