import { expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { downscalePng } from '@solus/server/execution/agents/tools/bounded-png'

// WHY: an agent's screenshot is replayed on every later provider request, so
// its size must be bounded; but a smaller picture that loses the page's
// content (thin text strokes, colours) would make the agent misread the page.

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = paint(x, y)
      image.data.set([red, green, blue, 255], (y * width + x) * 4)
    }
  }
  return PNG.sync.write(image)
}

test('an image within the bound is returned unchanged', async () => {
  const small = png(800, 600, () => [10, 20, 30])
  expect(await downscalePng(small, 1568)).toBe(small)
})

test('the long edge is scaled to the bound and the aspect ratio is kept', async () => {
  const phone = PNG.sync.read(await downscalePng(png(1170, 2532, () => [0, 0, 0]), 1568))
  expect([phone.width, phone.height]).toEqual([725, 1568])
})

test('each pixel is the mean of what it covers, so a one-pixel stroke is not dropped', async () => {
  // Alternating black and white columns: sampling would keep one colour; the
  // mean keeps the stroke as grey.
  const scaled = PNG.sync.read(await downscalePng(png(4, 2, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0])), 2))
  expect([scaled.width, scaled.height]).toEqual([2, 1])
  expect([...scaled.data.subarray(0, 4)]).toEqual([128, 128, 128, 255])
})

test('bytes that are not a PNG pass through', async () => {
  const notPng = Buffer.from('not an image')
  expect(await downscalePng(notPng, 10)).toBe(notPng)
})
