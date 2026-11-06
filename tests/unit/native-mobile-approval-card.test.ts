import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const card = readFileSync(join(import.meta.dir, '../../apps/mobile/src/features/threads/PendingApprovalCard.tsx'), 'utf8')
const screen = readFileSync(join(import.meta.dir, '../../apps/mobile/src/features/threads/ThreadDetailScreen.tsx'), 'utf8')

/**
 * The approval card sits above the composer, and its description can be a whole
 * shell command. Its actions must stay reachable and line up, whatever the labels.
 */
describe('the mobile approval card', () => {
  test('stacks its actions, so buttons of different labels share their edges', () => {
    expect(card).not.toContain('flex-row flex-wrap')
  })

  test('stops at the height the question and secret cards get, and scrolls its text', () => {
    expect(card).toContain('style={{ maxHeight: props.maxHeight }}')
    expect(card.indexOf('<ScrollView')).toBeLessThan(card.indexOf('props.approval.description'))
    expect(card.indexOf('</ScrollView>')).toBeLessThan(card.indexOf('props.approval.options.map'))
    expect(screen).toMatch(/<PendingApprovalCard[\s\S]*?maxHeight=\{pendingUserInputMaxHeight\}/)
  })
})
