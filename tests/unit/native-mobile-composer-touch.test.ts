import { describe, expect, test } from 'bun:test'
import { ComposerActionTouch } from '../../apps/mobile/src/features/threads/lib/composer-action-touch'

describe('composer touch ownership', () => {
  test('a release from Send cannot stop the new turn', () => {
    const touch = new ComposerActionTouch()
    touch.begin('primary:host:thread', 0)
    expect(touch.accept('stop:host:thread', 0)).toBe(false)
  })

  test('a queued release cannot act on the thread opened next', () => {
    const touch = new ComposerActionTouch()
    touch.begin('stop:host:old-thread', 0)
    expect(touch.accept('stop:host:new-thread', 0)).toBe(false)
  })

  test('a newly mounted Stop cannot consume a release from the outgoing button', () => {
    expect(new ComposerActionTouch().accept('stop:host:thread', 0)).toBe(false)
  })

  test('one touch activates its own action once; a separate touch can stop', () => {
    const touch = new ComposerActionTouch()
    touch.begin('primary:host:thread', 0)
    expect(touch.accept('primary:host:thread', 0)).toBe(true)
    expect(touch.accept('stop:host:thread', 0)).toBe(false)
    touch.begin('stop:host:thread', 1)
    expect(touch.accept('stop:host:thread', 1)).toBe(true)
  })

  test('cancelled or different touches cannot activate an action', () => {
    const touch = new ComposerActionTouch()
    touch.begin('stop:host:thread', 'first')
    expect(touch.accept('stop:host:thread', 'second')).toBe(false)
    touch.begin('stop:host:thread', 'first')
    touch.cancel()
    expect(touch.accept('stop:host:thread', 'first')).toBe(false)
  })

  test('accessibility activation does not need a physical touch', () => {
    expect(new ComposerActionTouch().accept('stop:host:thread', undefined)).toBe(true)
  })
})
