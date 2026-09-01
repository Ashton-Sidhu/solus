import { describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import {
  SLASH_COMMANDS,
  parseReviewCommand,
  type SlashCommandRunContext,
} from '@solus/workspace-ui/components/input/slash-commands'

describe('Solus slash commands', () => {
  test('parses the exact review command family and defaults bare review to working tree', () => {
    expect(parseReviewCommand('/review')).toEqual({ mode: 'working-tree' })
    expect(parseReviewCommand('/review:working-tree')).toEqual({ mode: 'working-tree' })
    expect(parseReviewCommand('/review:session')).toEqual({ mode: 'session' })
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
