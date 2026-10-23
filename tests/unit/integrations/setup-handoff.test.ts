import { describe, expect, test } from 'bun:test'
import type { IntegrationProbeResult } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { SetupHandoff } from '@solus/contracts/integrations/setup-handoff'

/**
 * "Set up with an agent" (docs/plans/mcp-integrations.md §13.4). What matters:
 * the hand-off is offered only where an agent can find the answer in the
 * vendor's docs, the prompt carries what the agent needs to find it, and it
 * never invites a secret into the conversation.
 */

function undetermined(reason: Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']): IntegrationProbeResult {
  return { outcome: 'undetermined', reason, signals: [] }
}

describe('IntegrationSignIn.setupNeedOfProbe', () => {
  test('an address the docs can correct is handed off', () => {
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('refused'), 'https://x.example/mcp')).toBe('endpoint')
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('oauth_unusable'), 'https://x.example/mcp')).toBe('endpoint')
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('not_mcp'), 'https://x.example/mcp')).toBe('endpoint')
  })

  test('a server that is down or slow gets Retry, not an agent', () => {
    // WHY: an agent cannot fix an outage, so the button would be a lie.
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('unavailable'), 'https://x.example/mcp')).toBeNull()
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('timeout'), 'https://x.example/mcp')).toBeNull()
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('unreachable'), 'https://x.example/mcp')).toBeNull()
    expect(IntegrationSignIn.setupNeedOfProbe(undetermined('redirected'), 'https://x.example/mcp')).toBeNull()
  })
})

describe('IntegrationSignIn.setupNeed', () => {
  test('a key or a missing OAuth client needs setup; automatic sign-in does not', () => {
    expect(new IntegrationSignIn({ auth: { kind: 'bearer', scheme: 'bearer' }, url: 'https://x.example/mcp' }).setupNeed).toBe('api-key')
    expect(new IntegrationSignIn({ auth: { kind: 'oauth', discover: 'https://x.example', registration: 'client-required' }, url: 'https://x.example/mcp' }).setupNeed).toBe('oauth-client')
    expect(new IntegrationSignIn({ auth: { kind: 'oauth', discover: 'https://x.example', registration: 'client-required', clientId: 'abc' }, url: 'https://x.example/mcp' }).setupNeed).toBeNull()
    expect(new IntegrationSignIn({ auth: { kind: 'oauth', discover: 'https://x.example', registration: 'dynamic' }, url: 'https://x.example/mcp' }).setupNeed).toBeNull()
    expect(new IntegrationSignIn({ auth: { kind: 'none' }, url: 'https://x.example/mcp' }).setupNeed).toBeNull()
  })
})

describe('SetupHandoff.prompt', () => {
  const target = { name: 'Zoom', url: 'https://mcp.zoom.us/mcp', callbackUrl: 'https://host.example/oauth/integration/callback' }

  test('an OAuth client prompt names the server and the callback URL to register', () => {
    const prompt = new SetupHandoff('oauth-client', target).prompt
    expect(prompt).toContain('https://mcp.zoom.us/mcp')
    expect(prompt).toContain('https://host.example/oauth/integration/callback')
  })

  test('every prompt forbids asking for a secret in the conversation', () => {
    for (const need of ['api-key', 'oauth-client', 'endpoint'] as const) {
      expect(new SetupHandoff(need, target).prompt).toContain('Do not ask me for a key, a token, a client secret, or a password')
    }
  })

  test('an endpoint prompt sends the person to Settings with the address, not to connect_integration', () => {
    const prompt = new SetupHandoff('endpoint', target).prompt
    expect(prompt).toContain('Settings → MCP')
    expect(prompt).not.toContain('connect_integration')
  })
})
