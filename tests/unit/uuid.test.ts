import { describe, expect, test } from 'bun:test'
import { uuid } from '../../src/shared/uuid'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  test('generates a version 4 UUID when randomUUID is unavailable', () => {
    // WHY: older mobile browsers provide getRandomValues but not randomUUID.
    // Every mobile-facing ID must still be created without crashing the client.
    const randomUuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })

    try {
      expect(uuid()).toMatch(UUID_V4_PATTERN)
    } finally {
      if (randomUuidDescriptor) {
        Object.defineProperty(globalThis.crypto, 'randomUUID', randomUuidDescriptor)
      } else {
        Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
      }
    }
  })
})
