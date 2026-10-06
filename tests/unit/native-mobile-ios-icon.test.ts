import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { iosIconSvg } from '../../apps/mobile/scripts/generate-ios-icon'

// iOS masks an app icon to its own rounded shape. The icon must be one opaque,
// full-bleed square with the Solus mark: the macOS icon's tile, edge, shadow and
// margin read as a second tile inside the system one.

const mobile = join(import.meta.dir, '../../apps/mobile')

describe('native iOS app icon', () => {
  test('iOS uses its own icon; Android keeps the shared one', () => {
    const expo = JSON.parse(readFileSync(join(mobile, 'app.json'), 'utf8')).expo
    expect(expo.ios.icon).toBe('./assets/icon-ios.png')
    expect(expo.icon).toBe('../../resources/icon.png')
  })

  test('the artwork is the favicon mark on one full-bleed background, with no frame of its own', () => {
    const svg = iosIconSvg()
    expect(svg).toContain('<rect width="1024" height="1024" fill="#ffffff"/>')
    expect(svg).toContain('M16,5 A11,11 0 0 1 27,16')
    for (const frame of ['filter', 'feDropShadow', 'stroke="#d2cfc5"']) expect(svg).not.toContain(frame)
    // The checked-in vector is what the generator writes now.
    expect(readFileSync(join(mobile, 'assets/icon-ios.svg'), 'utf8')).toBe(`${svg}\n`)
  })

  test('the PNG is a 1024pt opaque square whose corners are the background, not transparency', async () => {
    const image = sharp(join(mobile, 'assets/icon-ios.png'))
    const meta = await image.metadata()
    expect({ width: meta.width, height: meta.height, alpha: meta.hasAlpha }).toEqual({ width: 1024, height: 1024, alpha: false })
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
    for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [40, 512]]) {
      const offset = (y! * info.width + x!) * info.channels
      expect([data[offset], data[offset + 1], data[offset + 2]]).toEqual([255, 255, 255])
    }
  })
})
