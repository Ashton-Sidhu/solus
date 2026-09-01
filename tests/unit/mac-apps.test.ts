import { describe, expect, test } from 'bun:test'

import { findAppBundle } from '@solus/desktop-main/mac-apps'

const describeMac = process.platform === 'darwin' ? describe : describe.skip

describeMac('findAppBundle', () => {
  test('finds a bundle outside /Applications', async () => {
    // WHY: probing only /Applications missed both per-user installs and the
    // system utilities, which is half of why Settings looked empty.
    expect(findAppBundle('Terminal.app')).toBe('/System/Applications/Utilities/Terminal.app')
  })

  test('answers null for an application that is not installed', () => {
    expect(findAppBundle('Definitely Not Installed.app')).toBeNull()
  })
})
