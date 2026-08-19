import { describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import {
  SLASH_COMMANDS,
  type SlashCommandRunContext,
} from '@solus/workspace-ui/components/input/slash-commands'

describe('Solus slash commands', () => {
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
