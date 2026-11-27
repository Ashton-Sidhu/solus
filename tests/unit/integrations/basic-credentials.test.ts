import { describe, expect, test } from 'bun:test'
import { basicCredentials, basicUsernameError } from '@solus/contracts/integrations/basic-credentials'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'

describe('HTTP Basic credentials (RFC 7617)', () => {
  test('encodes user-id ":" password as the server decodes it', () => {
    // RFC 7617 §2's own example.
    expect(basicCredentials('Aladdin', 'open sesame')).toBe('QWxhZGRpbjpvcGVuIHNlc2FtZQ==')
    // WHY: the host sends the key as `Basic <key>`, so the server must read back exactly what the person typed.
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(basicCredentials('admin', 'p:ss')), (char) => char.charCodeAt(0)))
    expect(decoded).toBe('admin:p:ss')
  })

  test('encodes non-ASCII text as UTF-8', () => {
    // RFC 7617 §2.1's example with the UTF-8 charset; `btoa` alone throws on these characters.
    expect(basicCredentials('test', '123£')).toBe('dGVzdDoxMjPCow==')
  })

  test('refuses a user name the server would split at its colon, and an empty one', () => {
    // WHY: the server ends the user name at the first colon, so `a:b` would sign in as `a` with the wrong password.
    expect(basicUsernameError('a:b')).toBe('A user name cannot contain a colon.')
    expect(basicUsernameError('')).toBe('Enter a user name.')
    expect(basicUsernameError('admin')).toBeNull()
  })
})

describe('which servers ask for a user name and a password', () => {
  const url = 'https://search.example.com/mcp'
  test('only a key server whose challenge is Basic', () => {
    // WHY: a Bearer key server keeps the single API key field.
    expect(new IntegrationSignIn({ url, auth: { kind: 'bearer', scheme: 'basic' } }).takesUsernameAndPassword).toBe(true)
    expect(new IntegrationSignIn({ url, auth: { kind: 'bearer', scheme: 'bearer' } }).takesUsernameAndPassword).toBe(false)
    expect(new IntegrationSignIn({ url, auth: { kind: 'bearer', scheme: 'unspecified' } }).takesUsernameAndPassword).toBe(false)
    expect(new IntegrationSignIn({ url, auth: { kind: 'none' } }).takesUsernameAndPassword).toBe(false)
  })
})
