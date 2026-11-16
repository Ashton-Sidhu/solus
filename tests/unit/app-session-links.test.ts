import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSessionLink } from '@solus/contracts/apps'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { installTestWorkspaceTools } from './helpers/workspace-tools'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type Context = { clientId: string }
type Handler = (args: unknown[], ctx: Context) => Promise<AppSessionLink[]>

const OWNER: Context = { clientId: 'owner' }
const STRANGER: Context = { clientId: 'stranger' }
const APP = { id: 'app-1', name: 'Release Radar' }

let directory: string
let uninstall: () => void
const previous = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-app-session-links-')))
  process.env.SOLUS_DATA_DIR = directory
  uninstall = await installTestWorkspaceTools()
  const { ensureSessionRow } = await import('@solus/server/data/sessions/session-identity')
  await ensureSessionRow('session-new')
  await ensureSessionRow('session-other')
})
afterAll(async () => {
  uninstall()
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

/** The app RPCs as the transport registers them, keyed by method, over an Apps service that knows one app and its owner. */
async function appHandlers(): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>()
  const apps = {
    record: async (ctx: Context, appId: string) => {
      if (ctx.clientId !== OWNER.clientId || appId !== APP.id) throw new Error('App not found.')
      return APP
    },
  }
  const { registerAppHandlers } = await import('@solus/server/transport/handlers/app-handlers')
  // SAFETY: these methods reach only `register` of the server and `record` of the Apps service; the context needs only an actor.
  registerAppHandlers({ register: (method: string, handler: Handler) => handlers.set(method, (args, ctx) => handler(args, { ...ctx, actor: {} } as never)) } as never, { apps } as never)
  return handlers
}

test('a session the owner starts links to the app, and Unlink takes only that session off it', async () => {
  // WHY: the Sessions section's New starts a session for the app; without the
  // link it would not show in the list. Unlink must leave the other links in
  // place: it only says "this session is not about the app".
  const handlers = await appHandlers()
  const link = handlers.get('appSessionLink')!
  const unlink = handlers.get('appSessionUnlink')!

  await link([{ appId: APP.id, sessionId: 'session-other' }], OWNER)
  const linked = await link([{ appId: APP.id, sessionId: 'session-new' }], OWNER)
  expect(linked.map((row) => row.sessionId).sort()).toEqual(['session-new', 'session-other'])
  // A repeated link changes nothing.
  expect(await link([{ appId: APP.id, sessionId: 'session-new' }], OWNER)).toHaveLength(2)
  expect((await handlers.get('appSessions')!([{ appId: APP.id }], OWNER)).map((row) => row.sessionId).sort()).toEqual(['session-new', 'session-other'])

  const after = await unlink([{ appId: APP.id, sessionId: 'session-new' }], OWNER)
  expect(after.map((row) => row.sessionId)).toEqual(['session-other'])
  // A link that is not there changes nothing.
  expect(await unlink([{ appId: APP.id, sessionId: 'session-new' }], OWNER)).toHaveLength(1)
})

test('only the app\'s owner links or unlinks a session, and a request names a session', async () => {
  // WHY: an app is its host owner's (apps.md decision 10); the handler must ask the Apps service before it writes an edge.
  const handlers = await appHandlers()
  await expect(handlers.get('appSessionLink')!([{ appId: APP.id, sessionId: 'session-new' }], STRANGER)).rejects.toThrow('App not found.')
  await expect(handlers.get('appSessionUnlink')!([{ appId: APP.id, sessionId: 'session-other' }], STRANGER)).rejects.toThrow('App not found.')
  await expect(handlers.get('appSessionLink')!([{ appId: APP.id, sessionId: '' }], OWNER)).rejects.toThrow()
  expect((await handlers.get('appSessions')!([{ appId: APP.id }], OWNER)).map((row) => row.sessionId)).toEqual(['session-other'])
})
