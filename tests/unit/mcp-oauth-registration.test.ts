import { describe, expect, test } from 'bun:test'
import { McpOAuth, type OAuthMetadata } from '@solus/contracts/integrations/oauth-protocol'

const metadata: OAuthMetadata = {
  issuer: 'https://service.example',
  authorizationEndpoint: new URL('https://service.example/authorize'),
  tokenEndpoint: new URL('https://service.example/token'),
  registrationEndpoint: new URL('https://service.example/register'),
}

// A user must get the correct recovery step, rather than treating every failed
// registration as missing client credentials (including service failures).
describe('MCP registration errors', () => {
  for (const [status, code, message] of [
    [400, 'invalid_redirect_uri', 'The service refused this callback URL.'],
    [400, 'invalid_client_metadata', 'The service refused the registration details.'],
    [403, 'access_denied', 'The service does not allow automatic registration.'],
    [400, 'invalid_request', 'The service refused automatic registration (HTTP 400).'],
    [429, 'rate_limited', 'The service limited registration requests. Try again later.'],
    [503, 'unavailable', 'The service could not complete registration. Try again later.'],
    [200, 'invalid_response', 'The service returned an invalid OAuth client registration response.'],
  ] as const) {
    test(`${status} ${code} explains the failure without exposing response fields`, async () => {
      const oauth = new McpOAuth({ fetch: async () => Response.json({ error: code, client_secret: 'private-value' }, { status }) })
      await expect(oauth.register(metadata, ['https://host.example/oauth/integration/callback'])).rejects.toThrow(message)
    })
  }
})

test('dynamic registration marks loopback callbacks native and HTTPS host callbacks web', async () => {
  const requests: Array<{ application_type: string }> = []
  const oauth = new McpOAuth({ fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ client_id: 'registered' })
  } })
  await oauth.register(metadata, ['http://127.0.0.1:4100/oauth/integration/callback'])
  await oauth.register(metadata, ['https://host.example/oauth/integration/callback'])
  expect(requests.map((request) => request.application_type)).toEqual(['native', 'web'])
})
