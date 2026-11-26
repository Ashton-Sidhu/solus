import { describe, expect, test } from 'bun:test'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import { outsideAppAction } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { connectQr, copiedValueQr, isLoopbackUrl, qrDrawing } from '@solus/workspace-ui/components/connections/lib/outside-apps-share'

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

describe('the QR code on the Connect step', () => {
  test('opens the app\'s add form for an app whose handoff opens a link', () => {
    const action = outsideAppAction(guide('claude'), PUBLIC)
    expect(connectQr(action, PUBLIC)).toEqual({ kind: 'qr', link: action.kind === 'open' ? action.link : '' })
    expect(connectQr(outsideAppAction(guide('poke'), PUBLIC), PUBLIC)).toMatchObject({ kind: 'qr' })
  })

  test('for a copy-message app, opens the app with the message', () => {
    const action = outsideAppAction(guide('grok-bot'), PUBLIC)
    if (action.kind !== 'open') throw new Error('expected open')
    expect(connectQr(action, PUBLIC)).toEqual({ kind: 'qr', link: action.appLink ?? '' })
  })

  test('none for an app whose page needs the copied address, or for commands', () => {
    expect(connectQr(outsideAppAction(guide('chatgpt'), PUBLIC), PUBLIC)).toBeNull()
    expect(connectQr(outsideAppAction(guide('cursor'), LOCAL), LOCAL)).toBeNull()
    expect(connectQr(outsideAppAction(guide('claude-code'), LOCAL), LOCAL)).toBeNull()
  })

  test('never for a link to a loopback address, which another device cannot open', () => {
    const local = { ...guide('poke'), needsPublicUrl: false }
    expect(connectQr(outsideAppAction(local, LOCAL), LOCAL)).toEqual({ kind: 'loopback' })
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
