import { describe, expect, test } from 'bun:test'
import { checkAuthChoice, parseScopes, requestAuthOf, type AuthChoiceDraft } from '@solus/contracts/integrations/auth-choice'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'

// docs/plans/mcp-add-server.md: every client refuses the same Authentication
// input before it reaches the host, and sends the host the same choice.

const draft = (fields: Partial<AuthChoiceDraft>): AuthChoiceDraft => ({ kind: 'automatic', clientId: '', clientSecret: '', scopes: '', headers: [], ...fields })

describe('the Authentication of a new server', () => {
  test('Automatic with nothing typed sends no OAuth settings, so the probe alone decides', () => {
    expect(checkAuthChoice(draft({}))).toEqual({ ok: true, auth: { kind: 'automatic' }, values: [] })
  })

  test('a header Solus or MCP sets itself, a name given twice in another case, and a value with no name are refused', () => {
    expect(checkAuthChoice(draft({ kind: 'headers', headers: [{ name: 'Mcp-Session-Id', value: 'x' }] }))).toMatchObject({ ok: false, field: 'headers' })
    expect(checkAuthChoice(draft({ kind: 'headers', headers: [{ name: 'X-Key', value: '' }, { name: 'x-key', value: '' }] }))).toMatchObject({ ok: false, field: 'headers' })
    expect(checkAuthChoice(draft({ kind: 'headers', headers: [{ name: '', value: 'secret' }] }))).toMatchObject({ ok: false, field: 'headers' })
    expect(checkAuthChoice(draft({ kind: 'headers', headers: [{ name: '', value: '' }] }))).toMatchObject({ ok: false, field: 'headers' })
  })

  test('header names go on the record and only the values typed go to the host; Authorization is allowed', () => {
    const check = checkAuthChoice(draft({ kind: 'headers', headers: [{ name: ' Authorization ', value: 'Token abc' }, { name: 'X-Tenant', value: '' }, { name: '', value: '' }] }))
    expect(check).toEqual({ ok: true, auth: { kind: 'headers', names: ['Authorization', 'X-Tenant'] }, values: [{ name: 'Authorization', value: 'Token abc' }] })
  })

  test('scopes split on spaces and commas, lose repeats, and refuse a quote', () => {
    expect(parseScopes(' read,write  read ')).toEqual({ ok: true, scopes: ['read', 'write'] })
    expect(parseScopes('')).toEqual({ ok: true, scopes: null })
    expect(parseScopes('read "all"').ok).toBe(false)
  })

  test('a client secret needs its client ID; API key and None carry no fields', () => {
    expect(checkAuthChoice(draft({ kind: 'oauth', clientSecret: 's' }))).toMatchObject({ ok: false, field: 'clientId' })
    expect(checkAuthChoice(draft({ kind: 'oauth', clientId: ' id ', scopes: 'repo' }))).toEqual({ ok: true, auth: { kind: 'oauth', scopes: ['repo'], client: { clientId: 'id' } }, values: [] })
    expect(checkAuthChoice(draft({ kind: 'bearer', clientId: 'ignored' }))).toEqual({ ok: true, auth: { kind: 'bearer' }, values: [] })
    expect(checkAuthChoice(draft({ kind: 'none', headers: [{ name: 'X', value: 'y' }] }))).toEqual({ ok: true, auth: { kind: 'none' }, values: [] })
  })

  test('a plain Automatic sends no auth, so a host from before Add server still takes the add', () => {
    expect(requestAuthOf({ kind: 'automatic' })).toBeUndefined()
    expect(requestAuthOf({ kind: 'automatic', scopes: ['read'] })).toEqual({ kind: 'automatic', scopes: ['read'] })
    expect(requestAuthOf({ kind: 'none' })).toEqual({ kind: 'none' })
  })

  test('header values, an owner client, and chosen scopes keep the sign-in on the host; a plain OAuth server may sign in through the account', () => {
    const onHost = (auth: ConstructorParameters<typeof IntegrationSignIn>[0]['auth']) => new IntegrationSignIn({ auth, url: 'https://mcp.example.com/mcp' }).signsInOnHost
    expect(onHost({ kind: 'headers', names: ['X-API-Key'] })).toBe(true)
    expect(onHost({ kind: 'oauth', discover: 'https://mcp.example.com', registration: 'dynamic', scopes: ['read'] })).toBe(true)
    expect(onHost({ kind: 'oauth', discover: 'https://mcp.example.com', registration: 'dynamic' })).toBe(false)
    expect(onHost({ kind: 'bearer', scheme: 'bearer' })).toBe(false)
  })
})
