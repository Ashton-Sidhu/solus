import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { adoptCloudOriginIfPresent, configureUplinkAccountSource, uplinkAccountSource } from '@solus/client-core/uplink-account'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { configureCloudAccount, startupAccountRead } from '@solus/client-core/cloud-account'
import type { SavedServer } from '@solus/client-core/server-registry'

const origin = 'https://account.example'
const host = {
  hostId: 'abcdefghijklmnop', installationId: 'installation', label: 'My host', os: 'macos',
  routes: [{ kind: 'tunnel', url: 'https://host.example' }],
}
const fetchSpy = spyOn(globalThis, 'fetch')
afterAll(() => fetchSpy.mockRestore())
afterEach(() => {
  fetchSpy.mockReset()
  configureUplinkAccountSource(null)
  configureCloudAccount(null)
})

/** Requests to one path of the account origin; a signed-in start also reads the account once. */
const requestsTo = (path: string) => fetchSpy.mock.calls.filter(([url]) => String(url) === `${origin}${path}`)

// Run the actual web/mobile startup function with an in-memory saved catalog.
const source = readFileSync(new URL('../../apps/client/src/main.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function adoptCloudDirectory(')
const end = source.indexOf('async function bootFromCatalog(', start)
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

async function bootDirectory() {
  const state = { kind: 'unknown' }
  const saved: SavedServer[] = [{ id: 'paired', label: 'Paired host', url: 'https://paired.example', sessionToken: 'fixture', lastConnected: 1 }]
  const save = mock((servers: SavedServer[]) => { saved.splice(0, saved.length, ...servers) })
  const boot = new Function('adoptCloudOriginIfPresent', 'uplinkAccountSource', 'cloudOrigin',
    'location', 'loadServers', 'saveServers', 'mergeDirectoryIntoSaved', 'startupAccountRead',
    `${compiled}\nreturn adoptCloudDirectory();`)
  await boot(adoptCloudOriginIfPresent, uplinkAccountSource, state, { origin }, () => saved, save, mergeDirectoryIntoSaved, startupAccountRead)
  return { state, saved, save }
}

test('web/mobile startup uses one directory request and later refreshes fetch current hosts', async () => {
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [host] }))
  const { state, saved, save } = await bootDirectory()
  expect(state.kind).toBe('signed-in')
  expect(requestsTo('/v1/hosts')).toHaveLength(1)
  expect(requestsTo('/v1/account')).toHaveLength(1)
  expect(fetchSpy.mock.calls[0][0]).toBe(`${origin}/v1/hosts`)
  expect(fetchSpy.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { accept: 'application/json' } })
  expect(save).toHaveBeenCalledTimes(1)
  expect(saved.some((server) => server.installationId === host.installationId)).toBe(true)
  expect(saved.some((server) => server.id === 'paired')).toBe(true)
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [{ ...host, label: 'Renamed host' }] }))
  const refreshed = await uplinkAccountSource()?.listDirectory()
  expect(requestsTo('/v1/hosts')).toHaveLength(2)
  expect(refreshed?.hosts[0].label).toBe('Renamed host')
})

for (const scenario of [
  { name: 'signed out', response: () => Response.json({}, { status: 401 }), kind: 'signed-out', account: true },
  { name: 'host SPA fallback', response: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), kind: 'not-cloud', account: false },
  { name: 'server failure', response: () => Response.json({}, { status: 503 }), kind: 'not-cloud', account: false },
  { name: 'invalid directory', response: () => Response.json({ hosts: [null] }), kind: 'signed-in', account: true },
  { name: 'invalid JSON', response: () => new Response('{', { headers: { 'content-type': 'application/json' } }), kind: 'signed-in', account: true },
  { name: 'network failure', response: (): Response => { throw new Error('offline') }, kind: 'not-cloud', account: false },
]) {
  test(`${scenario.name} preserves saved hosts without a second startup request`, async () => {
    fetchSpy.mockImplementation(async () => scenario.response())
    const { state, saved, save } = await bootDirectory()
    expect(state.kind).toBe(scenario.kind)
    expect(requestsTo('/v1/hosts')).toHaveLength(1)
    expect(requestsTo('/v1/account')).toHaveLength(scenario.kind === 'signed-in' ? 1 : 0)
    expect(save).not.toHaveBeenCalled()
    expect(saved.map((server) => server.id)).toEqual(['paired'])
    expect(uplinkAccountSource() !== null).toBe(scenario.account)
  })
}

test('a valid empty directory remains a signed-in account', async () => {
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [] }))
  const { state, save } = await bootDirectory()
  expect(state.kind).toBe('signed-in')
  expect(save).toHaveBeenCalledTimes(1)
  expect(requestsTo('/v1/hosts')).toHaveLength(1)
})
