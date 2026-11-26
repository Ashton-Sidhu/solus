import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { runToolClient } from './helpers/run-tool-client'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let solusToolbox: typeof import('@solus/server/execution/agents/tools/solus-toolbox')['solusToolbox']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox'))
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
    expect(solusToolbox.works.list.alwaysLoad).toBeFalsy()
  })

  test('the endpoint lists alwaysLoad for the harness', async () => {
    const client = await runToolClient([solusToolbox.artifact.render, solusToolbox.works.list], {
      provider: 'claude-code', cwd: '/tmp', sessionId: () => undefined, abortSignal: new AbortController().signal, emit: () => {},
    })
    const listed = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool._meta?.['anthropic/alwaysLoad']]))
    expect(listed.get('render_artifact')).toBe(true)
    expect(listed.get('list_works')).toBeUndefined()
    await client.close()
  })
})

describe('the theme the fence guidance names', () => {
  test('every variable the guidance tells the agent to use is one the frame defines', async () => {
    // WHY: the frame cannot read the app's CSS; it gets only the tokens the
    // sandbox writes into it. A name the guidance teaches but the frame lacks
    // resolves to nothing, and the agent's chart draws without colour.
    const previousDocument = globalThis.document
    const previousGetComputedStyle = globalThis.getComputedStyle
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { className: '', getAttribute: () => null } } })
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
