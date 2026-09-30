import { describe, expect, test } from 'bun:test'
import { mountedConversationTabIds } from '@solus/workspace-ui/components/conversation/lib/conversation-pool'

// WHY: memory and hidden-tab work must stay flat however many tabs are open,
// while the few conversations a reader moves between stay instant.
describe('conversation pool', () => {
  test('keeps the active conversation and only the most recent hidden ones', () => {
    expect(mountedConversationTabIds(
      ['tab-d', 'tab-c', 'tab-b', 'tab-a'], 'tab-e',
      ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e'], true, 4,
    )).toEqual(['tab-e', 'tab-d', 'tab-c', 'tab-b'])
  })

  test('the count stays bounded as tabs open, one visit at a time', () => {
    const open = Array.from({ length: 40 }, (_, index) => `tab-${index}`)
    let mounted: string[] = []
    for (const tabId of open) mounted = mountedConversationTabIds(mounted, tabId, open, true)
    expect(mounted).toEqual(['tab-39', 'tab-38', 'tab-37', 'tab-36'])
  })

  test('revisiting a mounted tab moves it to the front without evicting another', () => {
    expect(mountedConversationTabIds(['tab-a', 'tab-b', 'tab-c'], 'tab-c', ['tab-a', 'tab-b', 'tab-c'], true))
      .toEqual(['tab-c', 'tab-a', 'tab-b'])
  })

  test('drops closed tabs', () => {
    expect(mountedConversationTabIds(['closed-tab', 'recent-tab'], 'active-tab', ['active-tab', 'recent-tab'], true))
      .toEqual(['active-tab', 'recent-tab'])
  })

  test('with no active tab, the recent conversations stay mounted', () => {
    expect(mountedConversationTabIds(['tab-a', 'tab-b'], null, ['tab-a', 'tab-b'], true)).toEqual(['tab-a', 'tab-b'])
  })

  test('an inactive shell mounts nothing, so two shells never hold one conversation', () => {
    expect(mountedConversationTabIds(['tab-a'], 'tab-b', ['tab-a', 'tab-b'], false)).toEqual([])
  })
})
