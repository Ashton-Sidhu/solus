import { pairQrSvgPath, type PairQrSvgPath } from './qrcode'

/**
 * What "Use Solus from your other apps" shows when the clipboard does not
 * work: the value to copy by hand, with a QR code of a link or an address that
 * another device can open (after T3 Code's share UX).
 */

/** The values a person copies, by the title of the dialog that shows one by hand. */
export const COPIED_VALUE_TITLES = {
  address: 'MCP address',
  message: 'Message',
  code: 'Pairing code',
  command: 'Command',
} as const

export type CopiedValueKind = keyof typeof COPIED_VALUE_TITLES

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]', '0.0.0.0'])

/** An address that only this computer can open: `localhost`, `*.localhost`, `127.x.x.x`, or `[::1]`. */
export function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const { hostname } = new URL(value)
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/** The QR code in the copy-by-hand dialog: a link or an address that another device can open; none for a message or a code. */
export function copiedValueQr(value: string): string | null {
  if (!URL.canParse(value) || /\s/.test(value)) return null
  return isLoopbackUrl(value) ? null : value
}

/** The QR's drawing, or null when the value is too long for a QR code. */
export function qrDrawing(value: string): PairQrSvgPath | null {
  try {
    return pairQrSvgPath(value)
  } catch {
    return null
  }
}
