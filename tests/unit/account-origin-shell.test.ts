import { describe, expect, test } from 'bun:test'
import { accountOriginShell } from '../../apps/client/src/lib/account-origin'

// docs/plans/fast-secure-startup.md, decision 3: the account origin's shell names itself
// and, signed in, who is signed in, so the page mounts signed in with no request. A host
// serves the same bundle with neither, so a page with no marker is a host page and
// spends no request finding out.

function page(elements: { [selector: string]: string | null }): Pick<Document, 'querySelector'> {
  return {
    querySelector: ((selector: string) => (selector in elements ? { textContent: elements[selector] } : null)) as Document['querySelector'],
  }
}

const marker = { 'meta[name="solus-account-origin"]': '' }
const SIGNED_IN = {
  identity: { sub: 'user_bob', email: 'bob@example.test', email_verified: true, name: 'Bob', picture: null },
  signedInAt: 1_700_000_000_000,
}

describe('the account origin shell', () => {
  test('a shell with the marker and an identity is the account origin, signed in as that person', () => {
    const shell = accountOriginShell(page({ ...marker, 'script#solus-account-identity': JSON.stringify(SIGNED_IN) }))
    expect(shell?.signedIn).toEqual({
      identity: { sub: 'user_bob', email: 'bob@example.test', emailVerified: true, name: 'Bob', picture: null },
      signedInAt: SIGNED_IN.signedInAt,
    })
  })

  test('a shell with no marker is a host page', () => {
    expect(accountOriginShell(page({ 'script#solus-account-identity': JSON.stringify(SIGNED_IN) }))).toBeNull()
  })

  test('no identity, or a broken one, is a signed-out visitor (a guest on a share link)', () => {
    expect(accountOriginShell(page(marker))?.signedIn).toBeUndefined()
    expect(accountOriginShell(page({ ...marker, 'script#solus-account-identity': '{not json' }))?.signedIn).toBeUndefined()
    expect(accountOriginShell(page({ ...marker, 'script#solus-account-identity': '{"identity":{"sub":""}}' }))?.signedIn).toBeUndefined()
  })

  // instant-share-open.md §4.14: signed in, the shell also names the person's directory,
  // so a fresh browser dials its hosts at once.
  test('a directory in the shell is parsed; a broken one is ignored', () => {
    const directory = { hosts: [], workspaces: [] }
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': JSON.stringify(directory) }))?.directory).toEqual(directory)
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': '{not json' }))?.directory).toBeUndefined()
    expect(accountOriginShell(page({ ...marker, 'script#solus-host-directory': '{"hosts":"x"}' }))?.directory).toBeUndefined()
    expect(accountOriginShell(page(marker))?.directory).toBeUndefined()
  })
})
