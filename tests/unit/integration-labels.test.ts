import { describe, expect, test } from 'bun:test'
import type { IntegrationProbeResult } from '@solus/contracts/integration-types'
import { authKindLabel, customUrlProblem, firstLine, probeOutcomeText, urlHost } from '../../packages/workspace-ui/src/components/settings/lib/integration-labels'

const tool = { name: 'ask_question', description: 'Ask about a repository', readOnly: true, destructive: false }

// Add is enabled for every outcome that creates a record. Only `undetermined`
// creates nothing (mcp-integrations.md §3.2), so it alone disables Add and offers a retry.
describe('probe outcome wording', () => {
  test('an anonymous server can be added and names its tool count', () => {
    const result: IntegrationProbeResult = { outcome: 'anonymous', auth: { kind: 'none' }, tools: [tool, { ...tool, name: 'read_wiki' }], signals: [] }
    expect(probeOutcomeText(result)).toEqual({ message: 'Works without sign-in, 2 tools', canAdd: true, canRetry: false })
    expect(probeOutcomeText({ ...result, tools: [tool] }).message).toBe('Works without sign-in, 1 tool')
  })

  test('a server that needs sign-in or a key can still be added before phase 2', () => {
    const oauth = probeOutcomeText({ outcome: 'oauth', auth: { kind: 'oauth', discover: 'https://x.example/.well-known', registration: 'dynamic' }, signals: [] })
    expect(oauth.canAdd).toBe(true)
    expect(oauth.message).toContain('later release')
    const key = probeOutcomeText({ outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals: [] })
    expect(key.canAdd).toBe(true)
    expect(key.message).toContain('API key')
  })

  test('an undetermined server cannot be added, says why, and can be retried', () => {
    const text = probeOutcomeText({ outcome: 'undetermined', reason: 'not_mcp', signals: [] })
    expect(text).toEqual({ message: 'This address is not an MCP server.', canAdd: false, canRetry: true })
  })
})

test('auth kind labels', () => {
  expect(authKindLabel({ kind: 'none' })).toBe('Open')
  expect(authKindLabel({ kind: 'none', oauth: { discover: 'https://x.example' } })).toBe('Open')
  expect(authKindLabel({ kind: 'oauth', discover: 'https://x.example', registration: 'client-required' })).toBe('Sign-in')
  expect(authKindLabel({ kind: 'bearer', scheme: 'unspecified' })).toBe('API key')
})

test('a custom URL must be HTTPS with no credentials or fragment', () => {
  expect(customUrlProblem('https://mcp.deepwiki.com/mcp')).toBeNull()
  expect(customUrlProblem('')).not.toBeNull()
  expect(customUrlProblem('http://mcp.deepwiki.com/mcp')).not.toBeNull()
  expect(customUrlProblem('https://user:pass@mcp.example.com/mcp')).not.toBeNull()
  expect(customUrlProblem('https://mcp.example.com/mcp?mode=tools')).toBeNull()
})

test('row helpers', () => {
  expect(urlHost('https://mcp.deepwiki.com/mcp')).toBe('mcp.deepwiki.com')
  expect(urlHost('not a url')).toBe('not a url')
  expect(firstLine('\n  Ask a question.\nMore detail.')).toBe('Ask a question.')
  expect(firstLine('')).toBe('')
})
