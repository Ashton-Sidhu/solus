import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The renderer asks main to stop, restart, change, delete,
// or create a cloud machine. Main holds the account token, so it checks every argument
// before a request leaves the machine: a malformed host id or spec reaches no website.

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const userData = mkdtempSync(join(tmpdir(), 'solus-managed-host-ipc-'))

mock.module('electron', () => ({
  // `whenReady` never settles: the stored account is not loaded or verified here.
  app: { getPath: () => userData, whenReady: () => new Promise(() => {}) },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unknown',
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  shell: { openExternal: async () => {} },
}))

const { ACCOUNT_CHANNELS, registerAccountIpc } = await import('../../apps/desktop/src/main/account/ipc')
const session = registerAccountIpc(() => {})
const requests: Array<{ path: string; method: string | undefined }> = []
session.cloudRequest = async (path: string, init: RequestInit = {}) => {
  requests.push({ path, method: init.method })
  return path.endsWith('/machine') ? new Response(null, { status: 204 }) : Response.json({ lifecycle: 'stopping', changed: true })
}

afterAll(() => rmSync(userData, { recursive: true, force: true }))

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

describe('the desktop bridge for cloud machines', () => {
  test('a malformed host id reaches no website', async () => {
    requests.length = 0
    for (const hostId of ['', 'x'.repeat(65), 42, null]) {
      expect(await invoke(ACCOUNT_CHANNELS.uplinkStopManagedHost, hostId)).toBeNull()
      expect(await invoke(ACCOUNT_CHANNELS.uplinkRestartManagedHost, hostId)).toBeNull()
      expect(await invoke(ACCOUNT_CHANNELS.uplinkUpdateManagedHostSpec, hostId, { packages: [] })).toBeNull()
      expect(await invoke(ACCOUNT_CHANNELS.uplinkDeleteManagedHost, hostId)).toBe(false)
    }
    expect(requests).toEqual([])
  })

  test('a spec change that names a size, or a create with a bad spec, reaches no website', async () => {
    requests.length = 0
    expect(await invoke(ACCOUNT_CHANNELS.uplinkUpdateManagedHostSpec, 'host_1', { size: 'large' })).toBeNull()
    expect(await invoke(ACCOUNT_CHANNELS.uplinkCreateManagedHost, 'org_1', { spec: { packages: ['rm -rf /'] } }))
      .toEqual({ ok: false, code: 'invalid_request', message: null })
    expect(await invoke(ACCOUNT_CHANNELS.uplinkCreateManagedHost, '', { label: 'Box' }))
      .toEqual({ ok: false, code: 'invalid_request', message: null })
    expect(requests).toEqual([])
  })

  test('a valid call goes to the machine route', async () => {
    requests.length = 0
    expect(await invoke(ACCOUNT_CHANNELS.uplinkStopManagedHost, 'host_1')).toBe('stopping')
    expect(await invoke(ACCOUNT_CHANNELS.uplinkUpdateManagedHostSpec, 'host_1', { setupScript: '' })).toBe(true)
    expect(await invoke(ACCOUNT_CHANNELS.uplinkDeleteManagedHost, 'host_1')).toBe(true)
    expect(requests).toEqual([
      { path: '/v1/hosts/host_1/stop', method: 'POST' },
      { path: '/v1/hosts/host_1/spec', method: 'PATCH' },
      { path: '/v1/hosts/host_1/machine', method: 'DELETE' },
    ])
  })
})
