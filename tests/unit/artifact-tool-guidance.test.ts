import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('@solus/server/execution/agents/tools/solus-toolbox')['solusToolbox']
let adaptClaudeTools: typeof import('@solus/server/execution/agents/claude/claude-tool-adapter')['adaptClaudeTools']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox'))
  ;({ adaptClaudeTools } = await import('@solus/server/execution/agents/claude/claude-tool-adapter'))
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

describe('the theme the fence guidance names', () => {
  test('every variable the guidance tells the agent to use is one the frame defines', async () => {
    // WHY: the frame cannot read the app's CSS; it gets only the tokens the
    // sandbox writes into it. A name the guidance teaches but the frame lacks
    // resolves to nothing, and the agent's chart draws without colour.
    const previousDocument = globalThis.document
    const previousGetComputedStyle = globalThis.getComputedStyle
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } })
    // Every Solus variable resolves, as it does in the app.
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ getPropertyValue: () => '#123456' }),
    })
    try {
      const { buildSandboxThemeCss } = await import('../../packages/workspace-ui/src/lib/artifactSandbox')
      const description = solusToolbox.artifact.render.description
      const named = [...new Set(description.match(/--[a-z][a-z0-9-]*[a-z0-9]/g) ?? [])]
      // `--chart-1 … --chart-6` names the series by its ends.
      named.push('--chart-2', '--chart-3', '--chart-4', '--chart-5')
      expect(named).toContain('--background')
      for (const isDark of [false, true]) {
        const css = buildSandboxThemeCss(isDark)
        for (const variable of named) expect(css).toContain(`${variable}:`)
      }
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
      Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: previousGetComputedStyle })
    }
  })
})
