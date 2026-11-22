import { describe, expect, mock, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { SlashCommandRunContext } from '@solus/workspace-ui/components/input/slash-commands'

// The sign-in commands use renderer stores. Parsing and clearing a draft do not.
mock.module('@solus/workspace-ui/contexts', () => ({
  agentAuthStore: {}, seatsStore: {}, seatProviderOf: () => null,
}))
const { SLASH_COMMANDS, parseReviewCommand } = await import('@solus/workspace-ui/components/input/slash-commands')

describe('Solus slash commands', () => {
  test('parses the exact review command family and defaults bare review to working tree', () => {
    expect(parseReviewCommand('/review')).toEqual({ mode: 'working-tree' })
    expect(parseReviewCommand('/review:working-tree')).toEqual({ mode: 'working-tree' })
    expect(parseReviewCommand('/review-guide explain the tests')).toEqual({ mode: 'session', argument: 'explain the tests' })
    expect(parseReviewCommand('/review:session')).toBeNull()
    expect(parseReviewCommand('/review:branch')).toEqual({ mode: 'branch' })
    expect(parseReviewCommand('/review:branch main')).toEqual({ mode: 'branch', argument: 'main' })
    expect(parseReviewCommand('/review:pr')).toEqual({ mode: 'pr' })
    expect(parseReviewCommand('/review https://github.com/acme/app/pull/42')).toEqual({
      mode: 'pr',
      argument: 'https://github.com/acme/app/pull/42',
    })
    expect(parseReviewCommand('/reviewer')).toBeNull()
    expect(parseReviewCommand('/review not-a-pr-url')).toBeNull()
  })

  test('/clear clears the current conversation', () => {
    let clearedConversations = 0
    const clear = SLASH_COMMANDS.find((command) => command.command === '/clear')
    const context: SlashCommandRunContext = {
      api: asHostApi({}),
      argument: '',
      sessionId: null,
      provider: null,
      // SAFETY: /clear does not read IPC context; this test exercises only its
      // renderer callback and supplies every callback in the command contract.
      ipcContext: undefined as never,
      clearCurrentConversation: () => clearedConversations++,
      addSystemMessage: () => {},
      appendGlobalInstructions: () => {},
      requestInputFocus: () => {},
    }

    clear?.run?.(context)

    expect(clearedConversations).toBe(1)
  })
})
