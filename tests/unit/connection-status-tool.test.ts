import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConnectNeeded } from '@solus/contracts/connections'

/**
 * The tool an agent reaches for when it needs an external account. What matters
 * is that it never carries a credential, that it raises the interrupt for the
 * conversation that is waiting, and that Confluence and Jira both resolve to the
 * one Atlassian grant they actually share.
 */

// No connection is configured in a disposable data dir, which is the state
// these cases are about.
mock.module('@solus/server/providers/github/auth', () => ({
  GitHubAuth: class { async status() { return { connected: false } } },
}))

// A build ships an Atlassian OAuth client or it does not, and the tool answers
// differently for each. Both branches are exercised below.
let atlassianOAuthConfigured = true
mock.module('@solus/server/atlassian/oauth', () => ({
  isOAuthConfigured: () => atlassianOAuthConfigured,
}))

type ToolsModule = typeof import('@solus/server/connections/connection-tools')
type AgentToolModule = typeof import('@solus/server/agents/tools/agent-tool')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let tools: ToolsModule
let runTool: AgentToolModule['executeAgentTool']

const raised: ConnectionConnectNeeded[] = []

function contextFor(sessionId: string | undefined) {
  return {
    provider: 'claude-code' as const,
    cwd: '/tmp',
    sessionId: () => undefined,
    solusSessionId: () => sessionId,
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: () => {},
  }
}

interface ToolPayload {
  provider: string
  connected: boolean
  askedUser?: boolean
  note?: string
}

const payloadOf = (text: string): ToolPayload => JSON.parse(text) as ToolPayload

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-connection-tool-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tools = await import('@solus/server/connections/connection-tools')
  ;({ executeAgentTool: runTool } = await import('@solus/server/agents/tools/agent-tool'))
  tools.setConnectionConnectNeededListener((request) => raised.push(request))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('connection_status', () => {
  test('a missing account raises the interrupt for the waiting conversation', async () => {
    raised.length = 0

    const result = await runTool(
      tools.connectionStatusAgentTool,
      { provider: 'github', reason: 'pull-requests' },
      contextFor('session-a'),
    )

    expect(payloadOf(result.text).connected).toBe(false)
    expect(payloadOf(result.text).askedUser).toBe(true)
    expect(raised).toEqual([
      { provider: 'github', reason: 'pull-requests', sessionId: 'session-a' },
    ])
  })

  test('Jira and Confluence both resolve to the one Atlassian connection', async () => {
    // They share a grant. Asking twice, or naming the wrong account back to the
    // user, would both be wrong.
    raised.length = 0

    await runTool(tools.connectionStatusAgentTool, { reason: 'jira' }, contextFor('session-b'))
    await runTool(tools.connectionStatusAgentTool, { reason: 'confluence' }, contextFor('session-b'))

    expect(raised.map((request) => request.provider)).toEqual(['atlassian', 'atlassian'])
    // The reason survives, so the card can say "Jira" to the user who said Jira.
    expect(raised.map((request) => request.reason)).toEqual(['jira', 'confluence'])
  })

  test('a run with no conversation reports the gap instead of raising a card', async () => {
    // An automation has nowhere to put an interrupt, and a card nobody can see
    // is a turn that waits forever.
    raised.length = 0

    const result = await runTool(
      tools.connectionStatusAgentTool,
      { provider: 'cloudflare', reason: 'deploy' },
      contextFor(undefined),
    )

    expect(payloadOf(result.text).askedUser).toBe(false)
    expect(raised).toEqual([])
  })

  test('a build with no OAuth client says so instead of offering a dead button', async () => {
    // Raising a card here would put a "Sign in" button in front of the user
    // that provably cannot work.
    raised.length = 0
    atlassianOAuthConfigured = false
    try {
      const result = await runTool(
        tools.connectionStatusAgentTool,
        { reason: 'jira' },
        contextFor('session-e'),
      )

      expect(payloadOf(result.text).askedUser).toBe(false)
      expect(payloadOf(result.text).note).toContain('no Atlassian OAuth client')
      expect(raised).toEqual([])
    } finally {
      atlassianOAuthConfigured = true
    }
  })

  test('an unknown account is refused rather than guessed at', async () => {
    const result = await runTool(
      tools.connectionStatusAgentTool,
      { provider: 'bitbucket', reason: 'unspecified' },
      contextFor('session-c'),
    )

    expect(result.ok).toBe(false)
    expect(result.text).toContain('atlassian')
  })

  test('an env-supplied Cloudflare token reads as connected and is never returned', async () => {
    const previousToken = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'cf-secret-value'
    try {
      const result = await runTool(
        tools.connectionStatusAgentTool,
        { provider: 'cloudflare', reason: 'deploy' },
        contextFor('session-d'),
      )

      expect(payloadOf(result.text).connected).toBe(true)
      expect(result.text).not.toContain('cf-secret-value')
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = previousToken
    }
  })
})
