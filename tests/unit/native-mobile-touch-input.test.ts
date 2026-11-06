import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('native touch input', () => {
  test('a custom question answer lets the native input own its text, so iOS autocorrect applies', () => {
    // WHY: a controlled value rebuilds the native text on each keystroke, and the
    // correction iOS has pending goes with it. A draft restores through defaultValue.
    const card = read('apps/mobile/src/features/threads/PendingUserInputCard.tsx')
    expect(card).toContain('defaultValue={draft?.customAnswer ?? ""}')
    expect(card).not.toContain('value={draft?.customAnswer')
  })

  test('the Android image viewer takes a pinch that starts outside the fitted image', () => {
    // WHY: a 16000x900 image fits as a thin strip, and the rest of the screen is black.
    const patch = read('patches/react-native-image-viewing@0.2.2.patch')
    expect(patch).toContain('-      <Animated.Image {...panHandlers}')
    expect(patch).toContain('+      <View {...panHandlers}')
    expect(read('package.json')).toContain('"react-native-image-viewing@0.2.2": "patches/react-native-image-viewing@0.2.2.patch"')
  })
})
