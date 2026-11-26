/**
 * The icon file of an app shortcut on macOS (`.icns`) and on Windows (`.ico`),
 * made from PNG images of the app's tile. Both formats hold PNG data as it is,
 * so this code only writes the two containers.
 */

export interface IconImage {
  /** The width and the height, in pixels. */
  size: number
  png: Uint8Array
}

/** The pixel sizes of a macOS icon, each with the types that hold it (a size at 1x and the half size at 2x). */
const ICNS_TYPES: ReadonlyArray<{ size: number; types: readonly string[] }> = [
  { size: 32, types: ['ic11'] },
  { size: 64, types: ['ic12'] },
  { size: 128, types: ['ic07'] },
  { size: 256, types: ['ic08', 'ic13'] },
  { size: 512, types: ['ic09', 'ic14'] },
  { size: 1024, types: ['ic10'] },
]

export const ICNS_SIZES: readonly number[] = ICNS_TYPES.map((entry) => entry.size)
/** Windows draws a shortcut from 16 to 256 pixels; 256 is the largest size an `.ico` names. */
export const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 256]

function imageOfSize(images: readonly IconImage[], size: number): IconImage {
  const image = images.find((candidate) => candidate.size === size)
  if (!image) throw new Error(`The icon has no image of ${size} pixels.`)
  return image
}

export function icnsFile(images: readonly IconImage[]): Buffer {
  const entries: Buffer[] = []
  for (const { size, types } of ICNS_TYPES) {
    const { png } = imageOfSize(images, size)
    for (const type of types) {
      const header = Buffer.alloc(8)
      header.write(type, 0, 'ascii')
      header.writeUInt32BE(8 + png.byteLength, 4)
      entries.push(header, Buffer.from(png))
    }
  }
  const body = Buffer.concat(entries)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + body.byteLength, 4)
  return Buffer.concat([header, body])
}

export function icoFile(images: readonly IconImage[]): Buffer {
  const chosen = ICO_SIZES.map((size) => imageOfSize(images, size))
  const directory = Buffer.alloc(6 + 16 * chosen.length)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(chosen.length, 4)
  let offset = directory.byteLength
  chosen.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index
    // A byte holds 0 to 255, so the format writes 256 as 0.
    directory.writeUInt8(size === 256 ? 0 : size, entry)
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.byteLength, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.byteLength
  })
  return Buffer.concat([directory, ...chosen.map(({ png }) => Buffer.from(png))])
}
