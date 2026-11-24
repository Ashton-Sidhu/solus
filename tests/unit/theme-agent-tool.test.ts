import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentPersonalRequest } from '@solus/contracts/agent-personal-request'
import type { PersonalSettingsDocument } from '@solus/contracts/settings'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { executeAgentTool } = await import('@solus/server/execution/agents/tools/agent-tool')
const { setConfigToolHost, updateConfigAgentTool, updateThemeAgentTool } = await import('@solus/server/execution/agents/tools/config-tools')

const context: AgentToolContext = {
  provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1',
  abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
}

/** What the person's client received, and the settings it holds after it applied them. */
let sent: AgentPersonalRequest[]
let personal: PersonalSettingsDocument

beforeEach(() => {
  sent = []
  personal = { themeMode: 'system' }
  setConfigToolHost({
    hostConfigChanged: () => {},
    deviceManager: {
      settings: () => ({ enabled: true, agentAccessEnabled: false, onboardingCompleted: true, autoShowAgentDevices: true, sshHosts: [] }),
      configure: async () => { throw new Error('not used') },
      saveSshHosts: async () => { throw new Error('not used') },
    },
    personal: async (_sessionId, request) => {
      sent.push(request)
      if (request.settings) personal = { ...personal, ...request.settings }
      return { reply: { ok: true, settings: personal, profile: [], device: null }, fromTurnClient: true }
    },
  })
})

describe('update_theme', () => {
  test("sends the person's client the same change as their own setting does, so every client follows it", async () => {
    // WHY: the theme has one owner, the person's settings on their clients
    // (docs/theme-css.md). A second path would let clients disagree.
    const css = '.dark { --solus-accent: #9ece6a; }'
    const result = await executeAgentTool(updateThemeAgentTool, { appearance: 'dark', css }, context)
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ themeMode: 'dark', themeCssCharacters: css.length })
    const fromTheme = sent.at(-1)

    await executeAgentTool(updateConfigAgentTool, { personal: { themeMode: 'dark', themeCss: css } }, context)
    expect(fromTheme).toEqual(sent.at(-1))
    expect(fromTheme).toEqual({ settings: { themeMode: 'dark', themeCss: css } })
  })

  test('changes only what it names: appearance alone keeps the CSS', async () => {
    personal = { themeMode: 'light', themeCss: 'body { color: red }' }
    await executeAgentTool(updateThemeAgentTool, { appearance: 'system' }, context)

    expect(sent).toEqual([{ settings: { themeMode: 'system' } }])
    expect(personal.themeCss).toBe('body { color: red }')
  })

  test('refuses CSS that loads a file, and a call that names nothing, before the client hears of it', async () => {
    expect((await executeAgentTool(updateThemeAgentTool, { css: '@import "https://example.com/a.css";' }, context)).ok).toBe(false)
    expect((await executeAgentTool(updateThemeAgentTool, {}, context)).ok).toBe(false)
    expect(sent).toEqual([])
  })
})
