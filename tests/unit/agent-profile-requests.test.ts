import { describe, expect, test } from 'bun:test'
import { agentProfileCloudRequests, type AgentProfileHttpRequest } from '@solus/client-core/agent-profile-requests'

// docs/plans/cloud-vault.md §2.3: every client reaches the person's account vault
// through the account routes, never the old per-provider or MCP-only routes.

const LINEAR = { kind: 'mcp', serverUrl: 'https://linear.example/mcp' } as const
const CONNECTED = { ref: LINEAR, material: 'key', status: 'connected', label: 'Ada', updatedAt: 1 } as const

function account(answer: (request: AgentProfileHttpRequest) => Response | null | 'signed-out') {
  const sent: AgentProfileHttpRequest[] = []
  const requests = agentProfileCloudRequests(async (request) => {
    sent.push(request)
    return answer(request)
  })
  return { requests, sent }
}

describe('the account vault calls', () => {
  test('status reads every connection from GET /v1/vault', async () => {
    const { requests, sent } = account(() => Response.json({ connections: [CONNECTED] }))
    expect(await requests.accountVault()).toEqual({ kind: 'ok', connections: [CONNECTED] })
    expect(sent).toEqual([{ method: 'GET', path: '/v1/vault' }])
  })

  test('a pasted key and a disconnect write, then read the statuses as they are after the write', async () => {
    // WHY: the cloud answers a save with one connection and a disconnect with no body; a client shows the whole list.
    const { requests, sent } = account((request) => request.method === 'DELETE' ? new Response(null, { status: 204 }) : request.method === 'PUT' ? Response.json(CONNECTED) : Response.json({ connections: [CONNECTED] }))
    expect(await requests.accountVaultSaveKey({ ref: LINEAR, key: 'k' })).toEqual({ kind: 'ok', connections: [CONNECTED] })
    expect(await requests.accountVaultDisconnect({ ref: LINEAR })).toEqual({ kind: 'ok', connections: [CONNECTED] })
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(['PUT /v1/vault', 'GET /v1/vault', 'DELETE /v1/vault', 'GET /v1/vault'])
    expect(sent[0].body).toEqual({ ref: LINEAR, key: 'k' })
  })

  test('a key the server refuses is an error with the cloud\'s words, and nothing is read after it', async () => {
    const { requests, sent } = account(() => Response.json({ error: 'credential_refused', message: 'The server refused this key.' }, { status: 422 }))
    expect(await requests.accountVaultSaveKey({ ref: LINEAR, key: 'bad' })).toEqual({ kind: 'error', code: 'credential_refused', message: 'The server refused this key.' })
    expect(sent).toHaveLength(1)
  })

  test('a sign-in starts at POST /v1/vault/connect; a server the cloud cannot sign in to is refused with its reason', async () => {
    let status = 200
    const { requests, sent } = account(() => status === 200 ? Response.json({ kind: 'browser', url: 'https://app.test/oauth/vault/start?ticket=t' }) : Response.json({ error: 'server_not_in_profile', message: 'Not in your profile.' }, { status }))
    expect(await requests.accountVaultConnect({ ref: { kind: 'provider', provider: 'github' } })).toEqual({ kind: 'ok', start: { kind: 'browser', url: 'https://app.test/oauth/vault/start?ticket=t' } })
    expect(sent[0]).toEqual({ method: 'POST', path: '/v1/vault/connect', body: { ref: { kind: 'provider', provider: 'github' } } })
    status = 404
    expect(await requests.accountVaultConnect({ ref: LINEAR })).toEqual({ kind: 'refused', message: 'Not in your profile.' })
  })

  test('signed out and offline are told apart', async () => {
    expect(await account(() => 'signed-out').requests.accountVault()).toEqual({ kind: 'signed-out' })
    expect(await account(() => null).requests.accountVault()).toEqual({ kind: 'offline' })
    expect(await account(() => new Response(null, { status: 401 })).requests.accountVault()).toEqual({ kind: 'signed-out' })
  })
})
