import { expect, test } from 'bun:test'
import { parseAccountDocumentRequest } from '@solus/contracts/account-documents'
import { accountDocumentCall } from '@solus/client-core/account-documents'

// plans/031 D7: every account document goes through one call and one table row, so
// a new document is a row, not a new set of calls on every client.

const hosts = { schemaVersion: 1, generation: 0, revision: 2, hosts: {}, updatedAt: 1 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('one call reads, patches, and clears a document by its row, and says why one did not land', async () => {
  const sent: Array<{ method: string; path: string }> = []
  const answers = [json(200, hosts), json(409, { error: 'host_list_conflict', current: hosts }), json(401, {}), json(500, { error: 'boom', message: 'Down' })]
  const call = accountDocumentCall(async (request) => { sent.push({ method: request.method, path: request.path }); return answers.shift()! })
  expect(await call({ name: 'hosts', method: 'GET' })).toEqual({ kind: 'ok', document: hosts })
  expect(await call({ name: 'hosts', method: 'PATCH', body: { generation: 0, expectedRevision: 1, set: {}, reset: [] } })).toEqual({ kind: 'conflict', reason: 'host_list_conflict', current: hosts })
  expect(await call({ name: 'hosts', method: 'DELETE' })).toEqual({ kind: 'signed-out' })
  expect(await call({ name: 'hosts', method: 'GET' })).toEqual({ kind: 'error', code: 'boom', message: 'Down' })
  expect(sent).toEqual([{ method: 'GET', path: '/v1/account/hosts' }, { method: 'PATCH', path: '/v1/account/hosts' }, { method: 'DELETE', path: '/v1/account/hosts' }, { method: 'GET', path: '/v1/account/hosts' }])
  expect(await accountDocumentCall(async () => null)({ name: 'hosts', method: 'GET' })).toEqual({ kind: 'offline' })
})

test('a request from another process is checked against the table before it is sent', () => {
  expect(parseAccountDocumentRequest({ name: 'hosts', method: 'GET' })).toEqual({ name: 'hosts', method: 'GET' })
  expect(parseAccountDocumentRequest({ name: 'secrets', method: 'GET' })).toBeNull()
  // WHY: a listing that carries a token is refused, never stripped and sent.
  expect(parseAccountDocumentRequest({ name: 'hosts', method: 'PATCH', body: { generation: 0, expectedRevision: null, set: { a: { id: 'a', label: 'A', installationId: 'a', lastConnected: 1, routes: [], sessionToken: 'secret' } }, reset: [] } })).toBeNull()
})
