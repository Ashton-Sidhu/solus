import { QrCode } from './qrcodegen'

export interface QrCodeMatrix {
  version: number
  size: number
  modules: boolean[][]
}

export function encodeQrByteMode(text: string): QrCodeMatrix {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM)
  const modules: boolean[][] = []
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = []
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y))
    modules.push(row)
  }
  return { version: qr.version, size: qr.size, modules }
}
