export interface ImageSize {
  width: number
  height: number
}

/** The IHDR chunk directly follows the 8-byte signature: 4 bytes length, the
 *  tag, then width and height as big-endian 32-bit integers. */
export function pngPixelSize(png: Buffer): ImageSize | null {
  if (png.byteLength < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}
