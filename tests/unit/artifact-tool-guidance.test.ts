import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('@solus/server/agents/tools/solus-toolbox')['solusToolbox']
let adaptClaudeTools: typeof import('@solus/server/agents/claude/claude-tool-adapter')['adaptClaudeTools']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/agents/tools/solus-toolbox'))
  ;({ adaptClaudeTools } = await import('@solus/server/agents/claude/claude-tool-adapter'))
})

// Agents must receive rendering guidance when tools load, including through the Claude adapter.
describe('HTML guidance without a system prompt', () => {
  test('the tools carrying guidance are never deferred behind tool search', () => {
    // WHY: Claude Code defers MCP tool descriptions by default. A deferred tool
    // is a bare name in the prompt, and a bare name carries no rule.
    expect(solusToolbox.artifact.render.alwaysLoad).toBe(true)
    expect(solusToolbox.works.create.alwaysLoad).toBe(true)
    expect(solusToolbox.works.update.alwaysLoad).toBe(true)
    // Tools with no guidance stay deferrable, so the prompt does not grow by
    // sixty descriptions to keep three.
    expect(solusToolbox.works.find.alwaysLoad).toBeFalsy()
  })

  test('the Claude adapter passes alwaysLoad through to the SDK tool', () => {
    const { server } = adaptClaudeTools(
      [solusToolbox.artifact.render, solusToolbox.works.find],
      {
        provider: 'claude-code',
        cwd: '/tmp',
        sessionId: () => undefined,
        solusSessionId: () => undefined,
        abortSignal: new AbortController().signal,
        parentToolUseId: () => undefined,
        emit: () => {},
      },
      'auto',
    )
    // SAFETY: `_registeredTools` is the MCP server's private registry, keyed
    // by tool name, and `_meta` is where the SDK writes the flag. Reading it is
    // the only way to see what the CLI will be told without spawning one.
    interface RegisteredToolMeta {
      _meta?: { 'anthropic/alwaysLoad'?: boolean }
    }
    const registry = (server.instance as unknown as {
      _registeredTools: { render_artifact?: RegisteredToolMeta; find_works?: RegisteredToolMeta }
    })._registeredTools
    expect(registry.render_artifact?._meta?.['anthropic/alwaysLoad']).toBe(true)
    expect(registry.find_works?._meta?.['anthropic/alwaysLoad']).toBeUndefined()
  })
})
