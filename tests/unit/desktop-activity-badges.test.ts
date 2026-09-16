import { expect, test } from 'bun:test'
import { DesktopActivityBadges } from '../../apps/desktop/src/main/activity-badges'

test('renderer senders share common sessions while retaining disjoint activity', () => {
  const badges = new DesktopActivityBadges()
  expect(badges.update(1, ['host-a/session-one', 'host-a/session-two'])).toBe(2)
  expect(badges.update(2, ['host-a/session-two', 'host-b/session-one'])).toBe(3)
  expect(badges.update(1, [])).toBe(2)
  expect(badges.remove(2)).toBe(0)
})

test('focus acknowledges renderer counts without retaining destroyed sender state', () => {
  const badges = new DesktopActivityBadges()
  badges.update(1, ['a'])
  badges.update(2, ['b'])
  badges.acknowledge()
  expect(badges.count).toBe(0)
  expect(badges.update(2, ['new'])).toBe(1)
  expect(badges.remove(1)).toBe(1)
})
