/**
 * Typing text into an iOS Simulator. serve-sim accepts only HID key events,
 * so text becomes a key per character on a US layout. Characters without a
 * key (emoji, accented letters) are skipped; the mobile text bridge reports
 * them as unsupported rather than sending something else.
 */

export interface HidKey {
  usage: number
  shift: boolean
}

const UNSHIFTED = new Map([
  [' ', 0x2c], ['\n', 0x28], ['\t', 0x2b], ['-', 0x2d], ['=', 0x2e], ['[', 0x2f], [']', 0x30], ['\\', 0x31],
  [';', 0x33], ["'", 0x34], ['`', 0x35], [',', 0x36], ['.', 0x37], ['/', 0x38],
])

const SHIFTED = new Map([
  ['!', 0x1e], ['@', 0x1f], ['#', 0x20], ['$', 0x21], ['%', 0x22], ['^', 0x23], ['&', 0x24], ['*', 0x25], ['(', 0x26], [')', 0x27],
  ['_', 0x2d], ['+', 0x2e], ['{', 0x2f], ['}', 0x30], ['|', 0x31], [':', 0x33], ['"', 0x34], ['~', 0x35], ['<', 0x36], ['>', 0x37], ['?', 0x38],
])

export function hidKeyForChar(char: string): HidKey | null {
  if (/^[a-z]$/.test(char)) return { usage: 0x04 + char.charCodeAt(0) - 97, shift: false }
  if (/^[A-Z]$/.test(char)) return { usage: 0x04 + char.charCodeAt(0) - 65, shift: true }
  if (/^[1-9]$/.test(char)) return { usage: 0x1e + char.charCodeAt(0) - 49, shift: false }
  if (char === '0') return { usage: 0x27, shift: false }
  const unshifted = UNSHIFTED.get(char)
  if (unshifted !== undefined) return { usage: unshifted, shift: false }
  const shifted = SHIFTED.get(char)
  if (shifted !== undefined) return { usage: shifted, shift: true }
  return null
}

export function iosTextKeys(text: string): HidKey[] {
  return [...text].flatMap((char) => {
    const key = hidKeyForChar(char)
    return key ? [key] : []
  })
}
