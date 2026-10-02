import { describe, expect, test } from 'bun:test'
import { selectedConversationLinkAction } from '@solus/desktop-main/conversation-link-action'

describe('native conversation link action', () => {
  test('opens the selected address from the original conversation', () => {
    let sourceTabId = 'remote-tab'
    const opened: { url: string; sourceTabId: string }[] = []
    const action = selectedConversationLinkAction(
      'http://localhost:5173/', sourceTabId, false,
      (url, tabId) => opened.push({ url, sourceTabId: tabId }),
    )
    expect(action?.label).toBe('Open link')
    // Switching tabs while the native menu is open must not change the host.
    sourceTabId = 'local-tab'
    Reflect.apply(action!.click!, undefined, [])
    expect(opened).toEqual([{ url: 'http://localhost:5173/', sourceTabId: 'remote-tab' }])
  })

  test('does not add a conversation action to input fields or other selections', () => {
    const onOpen = () => { throw new Error('No action should open') }
    expect(selectedConversationLinkAction('https://example.com', null, false, onOpen)).toBeNull()
    expect(selectedConversationLinkAction('https://example.com', 'tab', true, onOpen)).toBeNull()
    expect(selectedConversationLinkAction('See https://example.com', 'tab', false, onOpen)).toBeNull()
  })
})
