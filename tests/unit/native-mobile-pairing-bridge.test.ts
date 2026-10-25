import { describe, expect, test } from 'bun:test'
import {
  hostColumnLabel,
  isPairingBusy,
  PAIRED_HOLD_MS,
  pairedHoldMs,
  pairingPhase,
  pairingStatusLine,
  thisDeviceLabel,
} from '../../apps/mobile/src/features/hosts/lib/pairing-bridge'

describe('native pairing bridge shows the same phases as desktop and web', () => {
  test('with no host chosen the bridge is empty, or looking while the /health read runs', () => {
    expect(pairingPhase('idle', false)).toBe('empty')
    expect(pairingPhase('looking', false)).toBe('looking')
  })

  test('a known host is ready, then pairing, then paired or failed', () => {
    expect(pairingPhase('idle', true)).toBe('found')
    expect(pairingPhase('pairing', true)).toBe('pairing')
    expect(pairingPhase('paired', true)).toBe('paired')
    expect(pairingPhase('failed', true)).toBe('error')
  })

  test('the status line names the host, and a failure keeps its reason in the error banner', () => {
    expect(pairingStatusLine('empty', null)).toBeNull()
    expect(pairingStatusLine('looking', null)).toBe('Looking up host…')
    expect(pairingStatusLine('found', 'Studio')).toBe('Ready to pair')
    expect(pairingStatusLine('pairing', 'Studio')).toBe('Pairing with Studio…')
    expect(pairingStatusLine('paired', 'Studio')).toBe('Paired with Studio')
    expect(pairingStatusLine('error', 'Studio')).toBe("Couldn't pair")
  })
})

describe('native pairing bridge success hold', () => {
  test('the paired state is held before Home so the person sees it land', () => {
    expect(pairedHoldMs(false)).toBe(PAIRED_HOLD_MS)
    expect(PAIRED_HOLD_MS).toBeGreaterThan(0)
  })

  test('with reduced motion Home opens at once', () => {
    expect(pairedHoldMs(true)).toBe(0)
  })

  test('controls stay disabled during the hold, so the host cannot be paired twice', () => {
    expect(isPairingBusy('paired')).toBe(true)
    expect(isPairingBusy('pairing')).toBe(true)
    expect(isPairingBusy('looking')).toBe(true)
    expect(isPairingBusy('idle')).toBe(false)
    expect(isPairingBusy('failed')).toBe(false)
  })
})

describe('native pairing bridge columns', () => {
  test('this device names its kind and system', () => {
    expect(thisDeviceLabel('ios', false)).toEqual({ name: 'This iPhone', sub: 'iOS' })
    expect(thisDeviceLabel('ios', true)).toEqual({ name: 'This iPad', sub: 'iOS' })
    expect(thisDeviceLabel('android', false)).toEqual({ name: 'This phone', sub: 'Android' })
  })

  test('the host column is a new host until the host answers, then its name and system', () => {
    expect(hostColumnLabel(null)).toEqual({ name: 'New host', sub: '' })
    expect(hostColumnLabel({ name: 'Studio', os: 'macos' })).toEqual({ name: 'Studio', sub: 'macOS' })
    expect(hostColumnLabel({ name: 'Box' })).toEqual({ name: 'Box', sub: '' })
  })
})
