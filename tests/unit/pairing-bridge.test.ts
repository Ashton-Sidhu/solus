import { describe, expect, test } from 'bun:test'
import {
  lookUpHost,
  pairingPhase,
  pairingStatusLine,
  thisDevice,
} from '@solus/workspace-ui/components/servers/lib/pairing-bridge'

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'

function respondWith(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

describe('pairing phase', () => {
  const base = { targetUrl: 'http://192.168.1.42:3000', host: null, isPairing: false, isPaired: false, failedUrl: null }

  test('an empty form has no host to show', () => {
    expect(pairingPhase({ ...base, targetUrl: '' })).toBe('empty')
  })

  test('an address is looked up before the person can see the host', () => {
    expect(pairingPhase(base)).toBe('looking')
    expect(pairingPhase({ ...base, host: { name: 'gpu-box', os: 'linux' } })).toBe('found')
  })

  test('a failure belongs to the address it failed on, so a new address clears it', () => {
    const failed = { ...base, host: { name: 'gpu-box' }, failedUrl: base.targetUrl }
    expect(pairingPhase(failed)).toBe('error')
    expect(pairingPhase({ ...failed, targetUrl: 'http://192.168.1.43:3000', host: null })).toBe('looking')
  })

  test('a running or finished pairing outranks everything the form says', () => {
    expect(pairingPhase({ ...base, failedUrl: base.targetUrl, isPairing: true })).toBe('pairing')
    expect(pairingPhase({ ...base, isPairing: true, isPaired: true })).toBe('paired')
  })
})

describe('pairing status line', () => {
  test('names the host while pairing and once paired', () => {
    expect(pairingStatusLine('pairing', 'gpu-box')).toBe('Pairing with gpu-box…')
    expect(pairingStatusLine('paired', 'gpu-box')).toBe('Paired with gpu-box')
    expect(pairingStatusLine('empty', 'gpu-box')).toBe('')
  })
})

describe('this device', () => {
  test('the desktop app names itself by its platform', () => {
    expect(thisDevice('darwin', MAC_SAFARI)).toEqual({ name: 'This Mac', os: 'macos' })
    expect(thisDevice('win32', '')).toEqual({ name: 'This PC', os: 'windows' })
    expect(thisDevice('linux', '')).toEqual({ name: 'This PC', os: 'linux' })
  })

  test('a browser is read from its user agent, and an unknown system shows no logo', () => {
    expect(thisDevice('web', MAC_SAFARI)).toEqual({ name: 'This Mac', os: 'macos' })
    expect(thisDevice('web', IPHONE)).toEqual({ name: 'This iPhone', os: 'macos' })
    expect(thisDevice('web', ANDROID)).toEqual({ name: 'This browser', os: undefined })
  })
})

describe('host lookup', () => {
  const signal = new AbortController().signal

  test('a host on the local network gives its name and system', async () => {
    const fetchImpl = respondWith({ ok: true, installationId: 'abc', name: 'gpu-box', os: 'linux', requireAuth: true })
    expect(await lookUpHost('http://192.168.1.42:3000', signal, fetchImpl)).toEqual({ name: 'gpu-box', os: 'linux' })
  })

  test('a host behind its tunnel keeps its name, so the address stands in', async () => {
    const fetchImpl = respondWith({ ok: true, installationId: 'abc', requireAuth: true })
    expect(await lookUpHost('https://swift-otter.solus.sh', signal, fetchImpl)).toEqual({ name: 'swift-otter.solus.sh' })
  })

  test('an address that does not answer still shows where pairing will go', async () => {
    const fetchImpl = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect(await lookUpHost('http://10.0.0.9:3000', signal, fetchImpl)).toEqual({ name: '10.0.0.9:3000' })
  })
})
