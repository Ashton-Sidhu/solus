import { describe, expect, test } from 'bun:test'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import { outsideAppAction } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { copiedValueQr, isLoopbackUrl, qrDrawing } from '@solus/workspace-ui/components/connections/lib/outside-apps-share'

// The QR codes and the copy-by-hand dialog of "Use Solus in other apps" (after
// T3 Code's share UX). What a person would notice going wrong: a phone sent to
// a localhost address it cannot open, a QR for a value that is not a link, and
// no QR where the app's link would open it on the phone.

const PUBLIC = 'https://h-1.solus.dev/mcp'
const LOCAL = 'http://localhost:4810/mcp'

function guide(id: string): OutsideAppGuide {
  const found = OUTSIDE_APP_GUIDES.find((entry) => entry.id === id)
  if (!found) throw new Error(`No guide ${id}`)
  return found
}

describe('a loopback address', () => {
  test('is one only this computer opens', () => {
    for (const url of [LOCAL, 'http://127.0.0.1:4810/mcp', 'http://127.1.2.3/mcp', 'http://[::1]:4810/mcp', 'http://solus.localhost/mcp']) {
      expect(isLoopbackUrl(url)).toBe(true)
    }
  })

  test('a public or network address is not, and neither is text', () => {
    for (const value of [PUBLIC, 'http://192.168.1.4:4810/mcp', 'https://localhost.example.com/mcp', 'ABCD-1234']) {
      expect(isLoopbackUrl(value)).toBe(false)
    }
  })
})

describe('the copy-by-hand dialog', () => {
  test('has a QR for an address or a link another device can open', () => {
    expect(copiedValueQr(PUBLIC)).toBe(PUBLIC)
    expect(copiedValueQr('grokbot://app/v1/prompt?text=hi')).toBe('grokbot://app/v1/prompt?text=hi')
  })

  test('none for a loopback address, a message, or a pairing code', () => {
    expect(copiedValueQr(LOCAL)).toBeNull()
    expect(copiedValueQr(`Add the MCP server ${PUBLIC} and connect it.`)).toBeNull()
    expect(copiedValueQr('K7Q4-92XD')).toBeNull()
  })

  test('the QR of a link is drawn', () => {
    expect(qrDrawing(PUBLIC)?.path.length).toBeGreaterThan(0)
  })
})
