import { pairQrSvgPath, type PairQrSvgPath } from './qrcode'
import type { OutsideAppAction } from './outside-apps'

/**
 * What "Use Solus in other apps" shows a phone or a person when it cannot hand
 * a value over by itself: a QR code of an app's link (after T3 Code's share
 * UX), and the value to copy by hand when the clipboard does not work.
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

/**
 * The QR code on the Connect step: the link the primary action opens, for an
 * app whose handoff opens one with the address in it (`open`, or
 * `copy-message` with an app link). A phone cannot reach a loopback address,
 * so a link to one gets no QR: `loopback` says so instead. Null for a handoff
 * that copies the address and opens a page, and for commands.
 */
export type ConnectQr = { kind: 'qr'; link: string } | { kind: 'loopback' } | null

export function connectQr(action: OutsideAppAction, mcpUrl: string): ConnectQr {
  if (action.kind !== 'open') return null
  const link = action.copy === null ? action.link : action.appLink
  if (link === null) return null
  return isLoopbackUrl(mcpUrl) ? { kind: 'loopback' } : { kind: 'qr', link }
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
