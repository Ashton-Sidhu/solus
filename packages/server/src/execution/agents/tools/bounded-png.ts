import { PNG } from 'pngjs'
import { pngPixelSize } from '../../../docs/png'

/**
 * A PNG no larger than `maxEdge` on its long side.
 *
 * A browser capture is taken at the page's device pixel ratio, so a desktop
 * page on a Retina display is 2880×1800 and a phone preset is three times its
 * CSS size. A provider replays every tool image on each later request, so those
 * extra pixels are paid for again on every turn, and they buy nothing: Claude
 * scales a larger image down before it looks at it.
 *
 * The decode and encode use pngjs's streaming API, whose zlib work runs off the
 * event loop, so a large capture does not stall the server for every client.
 * An image that is already small enough, or that is not a PNG, is returned
 * unchanged.
 */
export async function downscalePng(png: Buffer, maxEdge: number): Promise<Buffer> {
  const size = pngPixelSize(png)
  if (!size || Math.max(size.width, size.height) <= maxEdge) return png
  const source = await decode(png)
  const scale = maxEdge / Math.max(source.width, source.height)
  const target = new PNG({
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  })
  averageInto(source, target)
  return encode(target)
}

function decode(png: Buffer): Promise<PNG> {
  return new Promise((resolve, reject) => {
    new PNG().parse(png, (error, decoded) => (error ? reject(error) : resolve(decoded)))
  })
}

function encode(png: PNG): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    png.pack()
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject)
  })
}

/** Each target pixel is the mean of the source pixels it covers. Text stays
 *  legible at the ratios a screenshot is reduced by, where nearest-neighbour
 *  sampling drops whole strokes. */
function averageInto(source: PNG, target: PNG): void {
  const xRatio = source.width / target.width
  const yRatio = source.height / target.height
  for (let y = 0; y < target.height; y++) {
    const top = Math.floor(y * yRatio)
    const bottom = Math.max(top + 1, Math.min(source.height, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < target.width; x++) {
      const left = Math.floor(x * xRatio)
      const right = Math.max(left + 1, Math.min(source.width, Math.floor((x + 1) * xRatio)))
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sourceY = top; sourceY < bottom; sourceY++) {
        let offset = (sourceY * source.width + left) * 4
        for (let sourceX = left; sourceX < right; sourceX++) {
          red += source.data[offset]!
          green += source.data[offset + 1]!
          blue += source.data[offset + 2]!
          alpha += source.data[offset + 3]!
          offset += 4
        }
      }
      const count = (bottom - top) * (right - left)
      const out = (y * target.width + x) * 4
      target.data[out] = Math.round(red / count)
      target.data[out + 1] = Math.round(green / count)
      target.data[out + 2] = Math.round(blue / count)
      target.data[out + 3] = Math.round(alpha / count)
    }
  }
}
