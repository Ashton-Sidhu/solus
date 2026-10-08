import { describe, expect, test } from 'bun:test'
import { integrationUrlSchema, type Integration } from '@solus/contracts/integration-types'
import {
  authKindLabel,
  firstLine,
  isIntegrationUrl,
  isUnsupportedMethodError,
  probeOutcomeView,
  upsertIntegration,
  urlHost,
  withoutIntegration,
} from '../../apps/mobile/src/features/settings/integrations'

// docs/plans/mcp-integrations.md §3.2 and §7 on the phone: a person sees what
// the probe found before Add, Add waits only for an undetermined server, and
// the phone accepts the same addresses the host does, without the `URL`
// object React Native implements only in part.

const signals: never[] = []

describe('probe outcome', () => {
  test('an anonymous server says it works without sign-in and counts its tools', () => {
    const tool = { name: 'ask', description: '', readOnly: true, destructive: false }
    expect(probeOutcomeView({ outcome: 'anonymous', auth: { kind: 'none' }, tools: [tool, tool], signals })).toEqual({
      title: 'Works without sign-in, 2 tools', canAdd: true, canRetry: false,
    })
    expect(probeOutcomeView({ outcome: 'anonymous', auth: { kind: 'none' }, tools: [tool], signals }).title).toBe('Works without sign-in, 1 tool')
  })

  test('a server that needs sign-in can be added now; sign-in arrives later', () => {
    const oauth = probeOutcomeView({ outcome: 'oauth', auth: { kind: 'oauth', discover: 'x', registration: 'dynamic' }, signals })
    const key = probeOutcomeView({ outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals })
    for (const view of [oauth, key]) expect(view).toEqual({ title: 'Needs sign-in; arrives in a later release', canAdd: true, canRetry: false })
  })

  test('an undetermined server cannot be added, says why in plain words, and offers Retry', () => {
    const view = probeOutcomeView({ outcome: 'undetermined', reason: 'not_mcp', signals })
    expect(view.canAdd).toBe(false)
    expect(view.canRetry).toBe(true)
    expect(view.detail).toBe('This address does not answer as an MCP server.')
  })
})

describe('integration address', () => {
  const cases = [
    'https://mcp.deepwiki.com/mcp',
    'https://example.com',
    'https://example.com:8443/sse',
    '  https://example.com/mcp  ',
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://user@example.com/mcp',
    'https://example.com/mcp?key=1',
    'https://example.com/mcp#top',
    'https://example.com/{tenant}/mcp',
    'https://example.com/%7Btenant%7D/mcp',
    'https://',
    'mcp.deepwiki.com/mcp',
    '',
  ]

  test('the phone accepts exactly the addresses the host accepts', () => {
    for (const value of cases) {
      expect({ value, accepted: isIntegrationUrl(value) }).toEqual({ value, accepted: integrationUrlSchema.safeParse(value).success })
    }
  })

  test('a row shows the host of the address', () => {
    expect(urlHost('https://mcp.deepwiki.com/mcp')).toBe('mcp.deepwiki.com')
    expect(urlHost('https://example.com:8443/sse')).toBe('example.com')
  })
})

describe('integration list', () => {
  const record = (id: string, name: string): Integration => ({
    id, organizationId: 'local', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
    auth: { kind: 'none' }, createdBy: null, createdAt: '', updatedAt: '',
  })

  test('a created or renamed integration takes its place by name, once', () => {
    const list = [record('a', 'Alpha'), record('c', 'Charlie')]
    expect(upsertIntegration(list, record('b', 'bravo')).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(upsertIntegration(list, record('a', 'Zulu')).map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(withoutIntegration(list, 'a').map((entry) => entry.id)).toEqual(['c'])
  })

  test('labels say how a server authenticates', () => {
    expect(authKindLabel({ kind: 'none' })).toBe('No sign-in')
    expect(authKindLabel({ kind: 'oauth', discover: 'x', registration: 'dynamic' })).toBe('Sign-in')
    expect(authKindLabel({ kind: 'bearer', scheme: 'bearer' })).toBe('API key')
  })

  test('a tool row shows the first line of its description', () => {
    expect(firstLine('\n  Ask a question.\nMore detail.')).toBe('Ask a question.')
  })

  test('an older host without the methods reads as unsupported, not as an error', () => {
    expect(isUnsupportedMethodError('Unknown method "integrationList"')).toBe(true)
    expect(isUnsupportedMethodError('SolusServer: no handler for "integrationList"')).toBe(true)
    expect(isUnsupportedMethodError('Not allowed')).toBe(false)
  })
})
