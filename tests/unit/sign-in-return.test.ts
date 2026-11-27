import { describe, expect, test } from 'bun:test'

;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { signInReturns } = await import('@solus/workspace-ui/components/connections/sign-in-return.svelte')
const { serverOfInstallation } = await import('@solus/workspace-ui/components/conversation/lib/host-providers-card')

// WHY: docs/host-provider-sign-in.md. The Sign in card of add_host sends the
// person to the new host's AI providers tab. The work waits in the
// conversation, so when the card closes the conversation must come back by
// itself, but only to a person who is still on that host's page: someone who
// went elsewhere meanwhile is not moved.

function waitFor(questionId: string, onHostPage: { value: boolean }) {
  const shown: string[] = []
  signInReturns.begin(
    { tabId: 'tab-1', serverId: 'build-mac', questionId, conversationTitle: 'Integration tests', providerLabel: 'Google Antigravity' },
    { isOnHostPage: () => onHostPage.value, showConversation: () => { shown.push('tab-1') } },
  )
  return shown
}

describe('return to the conversation after a sign-in', () => {
  test('the conversation comes back when its card closes while the person is on the host page', () => {
    const shown = waitFor('card-1', { value: true })
    signInReturns.cardClosed('another-card')
    expect(shown).toEqual([])
    signInReturns.cardClosed('card-1')
    expect(shown).toEqual(['tab-1'])
    expect(signInReturns.pending).toBeNull()
    // The return happens once.
    signInReturns.cardClosed('card-1')
    expect(shown).toEqual(['tab-1'])
  })

  test('a person who left the host page is not moved, and the bar is gone', () => {
    const onHostPage = { value: true }
    const shown = waitFor('card-2', onHostPage)
    onHostPage.value = false
    signInReturns.cardClosed('card-2')
    expect(shown).toEqual([])
    expect(signInReturns.pending).toBeNull()
  })

  test('Back to the conversation returns at once, and the later close does nothing more', () => {
    const shown = waitFor('card-3', { value: true })
    signInReturns.goBack()
    expect(shown).toEqual(['tab-1'])
    signInReturns.cardClosed('card-3')
    expect(shown).toEqual(['tab-1'])
  })

  test('the card finds the new host by the installation id that the session host names it by', () => {
    const servers = [{ id: 'mac-mini', installationId: 'inst-mini' }, { id: 'build-mac', installationId: 'inst-build' }]
    expect(serverOfInstallation(servers, 'inst-build')?.id).toBe('build-mac')
    expect(serverOfInstallation(servers, 'mac-mini')?.id).toBe('mac-mini')
    expect(serverOfInstallation(servers, 'not-yet-listed')).toBeNull()
  })
})
