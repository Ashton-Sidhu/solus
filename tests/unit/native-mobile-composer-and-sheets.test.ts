import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compactEditorInsets, nativeComposerOverflowsRow, oneRowEditorHeight, oneRowEditorInset } from '../../apps/mobile/src/features/threads/composer-layout'
import { resolveComposerTextRole } from '../../apps/mobile/src/lib/appearancePreferences'
import { KeyboardResumeGuard } from '../../apps/mobile/src/features/threads/android-keyboard-resume'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

describe('T3 compact composer layout', () => {
  test('text in the wider expanded field must fit its compact slot before collapsing', () => {
    expect(nativeComposerOverflowsRow({ width: 650, height: 23 }, 600, 23)).toBe(true)
    expect(nativeComposerOverflowsRow({ width: 599, height: 23 }, 600, 23)).toBe(false)
    expect(nativeComposerOverflowsRow({ width: 450, height: 23 }, 350, 23)).toBe(true)
    expect(nativeComposerOverflowsRow({ width: 0, height: 46 }, 320, 23)).toBe(true)
    expect(nativeComposerOverflowsRow({ width: 0, height: 0 }, 0, 23)).toBe(false)
  })

  test('the floating editor stays between the attach button and the model controls, also in RTL', () => {
    const row = { slotX: 44, slotWidth: 400, rowWidth: 600 }
    expect(compactEditorInsets({ ...row, isRTL: false })).toEqual({ left: 48, right: 160 })
    expect(compactEditorInsets({ ...row, isRTL: true })).toEqual({ left: 160, right: 48 })
  })

  test('the compact editor uses the upstream baseline inset and leaves room for scaled text', () => {
    expect(oneRowEditorInset({ fontSize: 16, lineHeight: 23 }, 'ios')).toBe(6)
    expect(oneRowEditorInset({ fontSize: 16, lineHeight: 23 }, 'android')).toBe(6)
    expect(oneRowEditorHeight(23)).toBe(36)
    expect(oneRowEditorHeight(41.5)).toBe(54)
    for (const platform of ['ios', 'android'] as const) {
      const text = { fontSize: 24, lineHeight: 35 }
      const inset = oneRowEditorInset(text, platform)
      expect(inset).toBeGreaterThanOrEqual(0)
      expect(oneRowEditorHeight(text.lineHeight, inset)).toBeGreaterThanOrEqual(text.lineHeight + 2 * inset)
    }
  })

  test('iOS native text follows Dynamic Type without scaling Android text twice', () => {
    const text = { fontSize: 16, lineHeight: 23 }
    expect(resolveComposerTextRole(text, 1.5, 'ios')).toEqual({ fontSize: 24, lineHeight: 34.5 })
    expect(resolveComposerTextRole(text, 1.5, 'android')).toEqual(text)
  })
})

describe('Android keyboard after an app switch (T3 #20803)', () => {
  test('a composer focused through the switch keeps its keyboard and stays above it', () => {
    const guard = new KeyboardResumeGuard()
    guard.keyboardEvent('keyboardWillShow')
    guard.composerFocusChanged(true)
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('send then Home: the composer blurred and the hide started, so the state is quarantined', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.composerFocusChanged(false)
    guard.keyboardEvent('keyboardWillHide')
    expect(guard.suspectOnResume()).toBe(true)
  })

  test('Back then Home during the hide keeps focus but is still quarantined', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.keyboardEvent('keyboardWillHide')
    expect(guard.suspectOnResume()).toBe(true)
  })

  test('a hide that finished, or a keyboard shown again, no longer counts as in progress', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.keyboardEvent('keyboardWillHide')
    guard.keyboardEvent('keyboardDidHide')
    expect(guard.suspectOnResume()).toBe(false)
    guard.keyboardEvent('keyboardWillHide')
    guard.keyboardEvent('keyboardWillShow')
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('a question that hides the focused composer takes its ownership, and gives it back when answered', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.questionShownChanged(true)
    expect(guard.suspectOnResume()).toBe(true)
    guard.questionShownChanged(false)
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('a thread change releases focus that the replaced editor never reported', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.composerFocusChanged(false) // ThreadDetailScreen's thread-change layout effect
    expect(guard.suspectOnResume()).toBe(true)
  })
})

// Native presentation without logic to run in bun: these check the contract
// the review asked for (callbacks and accessible names kept), not styling.
describe('Android menu icons take taps (T3 #20802)', () => {
  test('every hosted icon runs its row action, without becoming a second accessible or focusable target', () => {
    const menu = read('src/components/MaterialMenuPopup.android.tsx')
    expect(menu).toMatch(/<Pressable\s+accessible=\{false\}\s+focusable=\{false\}\s+disabled=\{props\.disabled\}\s+onPress=\{props\.onPress\}/)
    const icons = menu.split('<MenuIcon').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('/>')))
    expect(icons.length).toBe(4)
    for (const icon of icons) expect(icon).toContain('onPress=')
  })
})

describe('sheet close and apply affordances (T3 #21319)', () => {
  test('the generic sheet dismisses with an X that keeps its Close name and the owner callback', () => {
    const sheet = read('src/components/AppSheet.tsx')
    expect(sheet).toContain('icon: { type: "sfSymbol", name: "xmark" }')
    expect(sheet).toContain('accessibilityLabel: `Close ${props.title}`')
    expect(sheet).toContain('onDismiss={props.onClose}')
  })

  test('session settings: Close dismisses; Save applies a staged model or closes the unchanged picker', () => {
    const settings = read('src/features/threads/ThreadSettingsSheet.tsx')
    expect(settings).not.toContain('Cancel session settings')
    // T3 #21978: both platforms use SheetHeader; iOS shows the checkmark, Android the Save label.
    expect(settings).toContain('confirm={{ label: "Save session settings", onPress: commitAndClose }}')
    expect(settings).toContain('confirm={{ label: "Save", onPress: commitAndClose }}')
  })
})

describe('shared sheet header (T3 #21978)', () => {
  test('iOS: an X that dismisses on the left, a prominent checkmark only when the sheet confirms', () => {
    const header = read('src/components/SheetHeader.tsx')
    expect(header).toMatch(/placement="left">\s*<NativeHeaderToolbar\.Button\s+icon="xmark"/)
    expect(header).toContain('onPress={props.onCancel ?? props.onClose}')
    expect(header).toContain('disabled={props.dismissDisabled}')
    expect(header).toMatch(/\{confirmation \? \(\s*<NativeHeaderToolbar placement="right">\s*<NativeHeaderToolbar\.Button\s+icon="checkmark"\s+variant="prominent"/)
    expect(header).toContain('accessibilityLabel={confirmation.label}')
  })

  test('Android: an X and a labeled confirmation; inline sheets use the embedded bar', () => {
    const header = read('src/components/SheetHeader.android.tsx')
    expect(header).toContain('icon="xmark"')
    expect(header).toContain('loading={confirmation.loading}')
    expect(header).toContain('disabled={confirmation.disabled}')
    expect(header).toContain('onPress={confirmation.onPress}')
    expect(header).toContain('gestureEnabled: !props.dismissDisabled')
    expect(header).toContain('embedded={props.presentation === "inline"}')
  })

  test('a pull request sheet cannot be dismissed while a write runs (T3 #22390)', () => {
    const content = read('src/features/prs/detail/PullRequestSheetContent.tsx')
    expect(content).toContain('dismissDisabled={props.busy}')
    expect(content).toContain('gestureEnabled: !props.busy')
  })
})

// Native presentation without logic to run in bun: these check the contract of
// the port, not styling.
describe('new-thread draft and composer alignment (T3 #23206, #23355, #23366)', () => {
  test('the draft hero scrolls in the native-marked view and takes its top inset from UIKit, not a fixed iPhone bar height', () => {
    const draft = read('src/features/threads/NewTaskDraftScreen.tsx')
    expect(draft).not.toContain('ios:pt-[72px]')
    expect(draft).toMatch(/<ScreenScrollView\s+className="flex-1"\s+contentInsetAdjustmentBehavior="automatic"\s+contentContainerClassName="grow items-center justify-center pt-12"/)
    // Reserve the real dock, including expanded text and the task-source offer.
    expect(draft).toContain('paddingBottom: composerDockHeight + 16')
    expect(read('src/features/threads/ThreadDetailScreen.tsx')).toContain('props.draftMode.content(composerOverlayHeight ?? estimatedOverlayHeight)')
    // The title sits beside Back, as T3's draft page does.
    expect(draft).toContain('unstable_navigationItemStyle: "editor"')
  })

  test('an open sheet keeps the presentation it opened with until it is dismissed', () => {
    const root = read('src/navigation/RootNavigator.tsx')
    expect(root).toContain('flowPresentations.current.set(route.key, usesFlowScreen)')
    // A dismissed route releases its entry.
    expect(root).toMatch(/if \(!keys\.has\(key\)\) flowPresentations\.current\.delete\(key\)/)
  })

  test('iPad composes from the empty detail or the conversation header, not the sidebar toolbar', () => {
    expect(read('src/features/workspace/WorkspaceToolbar.ios.tsx')).not.toContain('placement="bottom"')
    expect(read('src/features/layout/createWorkspaceStackNavigator.ios.tsx')).toContain('<WorkspaceEmptyDetail onStartNewTask=')
    expect(read('src/features/threads/ThreadRouteScreen.tsx')).toContain('accessibilityLabel="New session"')
  })

  test('the composer keeps its safe-area padding while the keyboard moves; the sticky offset accounts for it', () => {
    const detail = read('src/features/threads/ThreadDetailScreen.tsx')
    expect(detail).not.toContain('composerFocused')
    expect(detail).toContain('const composerBottomInset = alignedBottomInset')
    expect(detail).toContain('offset={{ closed: 0, opened: composerBottomInset }}')
    expect(detail).toContain('Math.max(0, Math.max(insets.bottom, 12) - composerBottomGutter)')
  })
})
