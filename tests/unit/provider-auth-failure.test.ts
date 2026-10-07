import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'

// The Codex normalizer reaches the session database through its utilities.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { ClaudeTurnNormalizer } = await import('@solus/server/execution/agents/claude/claude-event-normalizer')
const { CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer')

// A turn the provider failed because it refused the login is not an ordinary
// failure: the event says so, the host expires the author's seat, and the
// clients offer sign-in again (cloud connections or the host's CLI login).
describe('a refused provider login', () => {
  test('Codex: a 401 or an unauthorized failure is an auth error', () => {
    const failed = (error: object) => new CodexTurnNormalizer({ planMode: false }).push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error } },
    })
    const unauthorized = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'

    expect(failed({ message: unauthorized })).toEqual([{ type: 'error', message: unauthorized, isError: true, sessionId: 'thread-1', kind: 'auth' }])
    expect(failed({ message: 'refused', codexErrorInfo: 'unauthorized' })).toMatchObject([{ type: 'error', kind: 'auth' }])
    expect(failed({ message: 'refused', codexErrorInfo: { httpStatusCode: 401 } })).toMatchObject([{ type: 'error', kind: 'auth' }])
    expect(failed({ message: 'API Error: 500 Internal server error', codexErrorInfo: 'internalServerError' })[0]).not.toHaveProperty('kind')
  })

  test('Claude: an invalid, expired, or unauthenticated login is an auth error', () => {
    const result = (message: string) => new ClaudeTurnNormalizer().push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: 1,
      num_turns: 1,
      result: message,
      total_cost_usd: 0,
      session_id: 'claude-session-1',
      usage: {},
    })

    expect(result('Invalid API key · Please run /login')).toMatchObject([{ type: 'error', kind: 'auth' }])
    expect(result('OAuth token has expired. Please obtain a new token or refresh your existing token.')).toMatchObject([{ type: 'error', kind: 'auth' }])
    expect(result('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toMatchObject([{ type: 'error', kind: 'auth' }])
    expect(result('API Error: 500 Internal server error')[0]).not.toHaveProperty('kind')
  })
})
