import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { routeNeedsProof, verifyHostProof } from '@solus/contracts/host-identity'
import { answersAsSavedHost } from '@solus/client-core/host-link'
import { loadHostIdentity, type HostIdentity } from '@solus/server/host/host-identity'

// WHY: docs/plans/host-routes.md D3. A client sends a credential on an `http:` route
// only after the host signs a fresh nonce with the identity key the client saved
// from a source it trusts. The installation id is public, and a LAN address can move
// to another device, so an answer that only names the right installation id must
// never be enough.

function newIdentity(): HostIdentity {
  return loadHostIdentity(mkdtempSync(join(tmpdir(), 'solus-identity-')))
}

const INSTALLATION = 'install-studio'

/** A fake host at every url: it names `installationId` and signs nonces with `signer`. */
function hostAnswering(installationId: string, signer: HostIdentity) {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    asked.push(url.href)
    const nonce = url.searchParams.get('nonce')
    return Response.json({ ok: true, installationId, name: 'Studio', ...(nonce ? { proof: signer.proveTo(nonce, installationId) } : {}) })
  }) as typeof fetch
  return { fetchImpl, asked }
}

const signal = () => AbortSignal.timeout(1_000)

describe('the proof of a host', () => {
  test('verifies only for the key, the nonce, and the installation id it was made for', () => {
    const host = newIdentity()
    const proof = host.proveTo('nonce-1', INSTALLATION)
    expect(verifyHostProof(host.publicKey(), 'nonce-1', INSTALLATION, proof)).toBe(true)
    expect(verifyHostProof(newIdentity().publicKey(), 'nonce-1', INSTALLATION, proof)).toBe(false)
    expect(verifyHostProof(host.publicKey(), 'nonce-2', INSTALLATION, proof)).toBe(false)
    expect(verifyHostProof(host.publicKey(), 'nonce-1', 'install-other', proof)).toBe(false)
    expect(verifyHostProof(host.publicKey(), 'nonce-1', INSTALLATION, { signature: 'not-a-signature' })).toBe(false)
  })

  test('a host keeps one key across restarts, so a client that saved it still trusts the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-identity-'))
    expect(loadHostIdentity(dir).publicKey()).toBe(loadHostIdentity(dir).publicKey())
  })

  test('is needed on an http route, but not on https or on the page that served this client', () => {
    expect(routeNeedsProof({ url: 'http://192.168.1.20:7777' })).toBe(true)
    expect(routeNeedsProof({ url: 'http://127.0.0.1:54123' })).toBe(true)
    expect(routeNeedsProof({ url: 'https://h-studio.solus.sh' })).toBe(false)
    expect(routeNeedsProof({ url: 'http://192.168.1.20:7777', source: 'page' })).toBe(false)
  })
})

describe('a route answers as the saved host', () => {
  const route = { url: 'http://192.168.1.20:7777' }

  test('when the device there signs with the saved key', async () => {
    const studio = newIdentity()
    const { fetchImpl } = hostAnswering(INSTALLATION, studio)
    expect(await answersAsSavedHost(fetchImpl, route, { installationId: INSTALLATION, identityKey: studio.publicKey() }, signal())).toBe(true)
  })

  test('never for a device that names the installation id but signs with another key', async () => {
    const { fetchImpl } = hostAnswering(INSTALLATION, newIdentity())
    expect(await answersAsSavedHost(fetchImpl, route, { installationId: INSTALLATION, identityKey: newIdentity().publicKey() }, signal())).toBe(false)
  })

  test('never on an http route while this client has no key for the host', async () => {
    const { fetchImpl, asked } = hostAnswering(INSTALLATION, newIdentity())
    expect(await answersAsSavedHost(fetchImpl, route, { installationId: INSTALLATION }, signal())).toBe(false)
    expect(asked).toEqual([])
  })

  test('each check sends a fresh nonce, so an old answer cannot be replayed', async () => {
    const studio = newIdentity()
    const { fetchImpl, asked } = hostAnswering(INSTALLATION, studio)
    const saved = { installationId: INSTALLATION, identityKey: studio.publicKey() }
    await answersAsSavedHost(fetchImpl, route, saved, signal())
    await answersAsSavedHost(fetchImpl, route, saved, signal())
    const nonces = asked.map((url) => new URL(url).searchParams.get('nonce'))
    expect(nonces.every(Boolean)).toBe(true)
    expect(new Set(nonces).size).toBe(2)
  })

  test('on an https route by the installation id alone', async () => {
    const { fetchImpl, asked } = hostAnswering(INSTALLATION, newIdentity())
    expect(await answersAsSavedHost(fetchImpl, { url: 'https://h-studio.solus.sh' }, { installationId: INSTALLATION }, signal())).toBe(true)
    expect(new URL(asked[0]!).searchParams.has('nonce')).toBe(false)
  })
})
