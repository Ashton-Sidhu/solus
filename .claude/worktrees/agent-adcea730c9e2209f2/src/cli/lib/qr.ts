import { encodeQrByteMode } from '../../client-core/qr'

export function renderQrAscii(text: string): string {
  const qr = encodeQrByteMode(text)
  const border = 4
  const lines: string[] = []
  for (let y = -border; y < qr.size + border; y++) {
    let line = ''
    for (let x = -border; x < qr.size + border; x++) {
      const dark = x >= 0 && x < qr.size && y >= 0 && y < qr.size && qr.modules[y]![x]!
      line += dark ? '██' : '  '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
