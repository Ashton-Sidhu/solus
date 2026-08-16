import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  dismissSkew,
  forgetSkewDismissals,
  isSkewDismissed,
  skewDismissalKey,
  versionSkewNotice,
} from '../../src/client-core/version-skew'

const previousLocalStorage = globalThis.localStorage
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
})

describe('version-skew notice', () => {
  test('matching versions or a silent host produce no notice', () => {
    expect(versionSkewNotice('laptop', '1.2.0', {}, '1.2.0')).toBeNull()
    expect(versionSkewNotice('laptop', undefined, {}, '1.2.0')).toBeNull()
  })

  test('an older host names the features its skew actually gates', () => {
    // WHY: step-3 rider — remediation text is capability-derived, so the user
    // learns what updating buys them, not just that numbers differ.
    const notice = versionSkewNotice(
      'studio',
      '0.9.0',
      { attachUpload: true, automations: false },
      '1.0.0',
    )
    expect(notice?.direction).toBe('host-older')
    expect(notice?.remediation).toContain('Update Solus on studio')
    expect(notice?.remediation).toContain('automations')
    expect(notice?.remediation).not.toContain('file attachments')
  })

  test('a newer host tells the client to update instead', () => {
    const notice = versionSkewNotice('studio', '2.0.0', {}, '1.0.0')
    expect(notice?.direction).toBe('host-newer')
    expect(notice?.remediation).toContain('this client')
  })

  test('dismissal is keyed by host and both versions — either change resurfaces it', () => {
    const key = skewDismissalKey('host-a', '1.0.0', '0.9.0')
    dismissSkew(key)
    expect(isSkewDismissed(key)).toBe(true)
    expect(isSkewDismissed(skewDismissalKey('host-a', '1.0.1', '0.9.0'))).toBe(false)
    expect(isSkewDismissed(skewDismissalKey('host-a', '1.0.0', '0.9.1'))).toBe(false)
    expect(isSkewDismissed(skewDismissalKey('host-b', '1.0.0', '0.9.0'))).toBe(false)
  })

  test('forgetting a host purges its dismissals and nobody else\'s', () => {
    dismissSkew(skewDismissalKey('host-a', '1.0.0', '0.9.0'))
    dismissSkew(skewDismissalKey('host-b', '1.0.0', '0.9.0'))
    forgetSkewDismissals('host-a')
    expect(isSkewDismissed(skewDismissalKey('host-a', '1.0.0', '0.9.0'))).toBe(false)
    expect(isSkewDismissed(skewDismissalKey('host-b', '1.0.0', '0.9.0'))).toBe(true)
  })
})
