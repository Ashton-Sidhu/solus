import { describe, expect, test } from 'bun:test'
import { accountOriginShell } from '../../apps/client/src/lib/account-origin'

// docs/plans/instant-share-open.md: the account origin's shell names itself and carries
// the provider's metadata; a host serves the same bundle with neither, so a page with
// no marker is a host page and spends no request finding out.

function page(elements: { [selector: string]: string | null }): Pick<Document, 'querySelector'> {
  return {
    querySelector: ((selector: string) => (selector in elements ? { textContent: elements[selector] } : null)) as Document['querySelector'],
  }
}

const METADATA = {
  issuer: 'https://app.solus.sh',
  authorization_endpoint: 'https://app.solus.sh/api/auth/oauth2/authorize',
  token_endpoint: 'https://app.solus.sh/api/auth/oauth2/token',
  userinfo_endpoint: 'https://app.solus.sh/api/auth/oauth2/userinfo',
  revocation_endpoint: 'https://app.solus.sh/api/auth/oauth2/revoke',
}

describe('the account origin shell', () => {
  test('a shell with the marker is the account origin, with its metadata parsed', () => {
    const shell = accountOriginShell(page({ 'meta[name="solus-account-origin"]': '', 'script#solus-oidc-discovery': JSON.stringify(METADATA) }))
    expect(shell).toEqual({ discovery: METADATA })
  })

  test('a shell with no marker is a host page', () => {
    expect(accountOriginShell(page({ 'script#solus-oidc-discovery': '{"issuer":"x"}' }))).toBeNull()
  })

  test('missing, broken, or incomplete metadata still names the account origin; the sign-in reads the metadata itself', () => {
    expect(accountOriginShell(page({ 'meta[name="solus-account-origin"]': '' }))).toEqual({ discovery: undefined })
    expect(accountOriginShell(page({ 'meta[name="solus-account-origin"]': '', 'script#solus-oidc-discovery': '{not json' }))).toEqual({ discovery: undefined })
    expect(accountOriginShell(page({ 'meta[name="solus-account-origin"]': '', 'script#solus-oidc-discovery': '{"issuer":"https://app.solus.sh"}' }))).toEqual({ discovery: undefined })
  })

  // §4.14: signed in, the shell also names the person's directory, so a fresh
  // browser dials its hosts while the sign-in completes.
  test('a directory in the shell is parsed; a broken one is ignored', () => {
    const directory = { hosts: [], workspaces: [] }
    const marker = { 'meta[name="solus-account-origin"]': '' }
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': JSON.stringify(directory) }))?.directory).toEqual(directory)
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': '{not json' }))?.directory).toBeUndefined()
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': '{"hosts":"x"}' }))?.directory).toBeUndefined()
    expect(accountOriginShell(page(marker))?.directory).toBeUndefined()
  })
})
