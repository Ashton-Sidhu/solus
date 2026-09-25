import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { playwrightEncoderPool, type EncoderChromium } from '@solus/server/browser/recording-encoder-playwright'

/**
 * The recording encoder against a real Chromium.
 *
 * What matters is the file format: GitHub plays MP4 and refuses WebM, so a
 * recording that is not an MP4 cannot go on a pull request. A fake cannot prove
 * that; only the Chromium the host will actually use can. Skipped when this
 * machine has no Playwright Chromium.
 */

async function loadChromium(): Promise<EncoderChromium | null> {
  try {
    const loaded: { chromium?: EncoderChromium } = await import('playwright-core')
    const chromium = loaded.chromium
    if (!chromium || typeof chromium.launch !== 'function') return null
    const probe = await chromium.launch({ headless: true, args: [] }).catch(() => null)
    if (!probe) return null
    await probe.close()
    return chromium
  } catch {
    return null
  }
}

const chromium = await loadChromium()

/** JPEG frames of a moving square, drawn by the browser itself so the test
 *  needs no image fixture. */
async function jpegFrames(count: number): Promise<Uint8Array[]> {
  const browser = await chromium!.launch({ headless: true, args: [] })
  try {
    const page = await browser.newPage()
    const encoded = await page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      const frames = [];
      for (let i = 0; i < ${count}; i++) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 320, 240);
        context.fillStyle = '#d97757';
        context.fillRect(i * 8, 80, 60, 60);
        frames.push(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      }
      return frames;
    })()`)
    return z.array(z.string()).parse(encoded).map((base64) => new Uint8Array(Buffer.from(base64, 'base64')))
  } finally {
    await browser.close()
  }
}

describe.skipIf(!chromium)('recording encoder (Playwright Chromium)', () => {
  test('turns JPEG frames into an MP4', async () => {
    const frames = await jpegFrames(30)
    const pool = playwrightEncoderPool(chromium!)
    const encoder = await pool.open({ width: 320, height: 240 })
    try {
      for (const frame of frames) {
        await encoder.frame(frame)
      }
      const mp4 = await encoder.finish()
      expect(mp4.length).toBeGreaterThan(1000)
      // An MP4 opens with a `ftyp` box: 4 bytes of size, then the type.
      expect(Buffer.from(mp4.subarray(4, 8)).toString('ascii')).toBe('ftyp')
    } finally {
      await encoder.dispose()
      await pool.close()
    }
  }, 60_000)
})
