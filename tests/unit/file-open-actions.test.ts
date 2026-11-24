import { beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import type { Permission } from '@solus/contracts/permissions'
import type { LocalFileCopyAction, LocalFileCopyResult } from '@solus/contracts/local-file-copy'
import type { AssetCreateUrlRequest } from '@solus/contracts/rpc'

let isLocal = false
let permissions: Permission[] = []
let advertisedTarget: { host: string; user: string } | undefined
let savedTarget: string | undefined
let isReady = true
let platform = 'darwin'
let copyResult: LocalFileCopyResult
let origin = 'https://box.example'

const openExternal = mock(async (_url: string) => true)
const openDesktopFile = mock(async (_path: string, _action: 'open' | 'reveal') => true)
const showLocalFileCopy = mock(async (_name: string, _data: ArrayBuffer, _action: LocalFileCopyAction) => copyResult)
const assetCreateUrl = mock(async (_ctx: IpcContext | undefined, _request: AssetCreateUrlRequest) => ({ relativeUrl: '/api/assets/file.signature', expiresAt: 42 }))
const openInEditor = mock(async () => true)
const progressError = mock(() => {})
const tools = { state: 'ready', value: { editors: [{ id: 'cursor', name: 'Cursor', isTerminal: false }] } }
const fileActionsDirectory = `${import.meta.dir}/../../packages/workspace-ui/src/components/files/lib`
mock.module(Bun.resolveSync('@solus/client-core/host-policy', fileActionsDirectory), () => ({ hostPolicy: { isClientMachine: () => isLocal } }))
mock.module(Bun.resolveSync('@solus/client-core/local-api', fileActionsDirectory), () => ({
  localApi: { getPlatform: () => platform, openExternal, get showLocalFileCopy() { return platform === 'web' ? undefined : showLocalFileCopy } },
}))
mock.module(Bun.resolveSync('@solus/client-core/server-connections', fileActionsDirectory), () => ({ serverConnections: { httpOriginFor: () => origin } }))
mock.module('@solus/workspace-ui/contexts/hosts/hosts.svelte', () => ({
  hosts: {
    get: () => ({
      serverInfo: isReady
        ? { state: 'ready', value: { installationId: 'remote', sshTarget: advertisedTarget } }
        : { state: 'loading' },
      hasDesktopHandlers: isLocal,
      me: { may: (permission: Permission) => permissions.includes(permission) },
      tools,
    }),
    get device() { return platform === 'web' ? null : { id: 'viewer', tools } },
  },
}))
mock.module('@solus/workspace-ui/components/connections/forwarded-hosts.store.svelte', () => ({
  forwardedHostsStore: {
    hostsFor: (serverId: string) => serverId === 'viewer' && savedTarget
      ? [{ installationId: 'remote', sshTarget: savedTarget, route: { source: 'ssh' } }]
      : [],
  },
}))
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { error: mock(() => {}), progress: () => ({ error: progressError, success: mock(() => {}) }) },
}))

const { fileOpenRoute, openFileAction } = await import('@solus/workspace-ui/components/files/lib/file-open-actions')
const target = {
  serverId: 'remote', cwd: '/work', path: 'src/app.ts',
  api: { openDesktopFile, openInEditor, assetCreateUrl }, ctx: {} as IpcContext,
}

beforeEach(() => {
  isLocal = false
  isReady = true
  platform = 'darwin'
  copyResult = 'done'
  origin = 'https://box.example'
  permissions = ['host.use', 'host.files.read']
  advertisedTarget = { host: 'box.tail.ts.net', user: 'dev' }
  savedTarget = undefined
  openExternal.mockClear()
  openDesktopFile.mockClear()
  openInEditor.mockClear()
  showLocalFileCopy.mockClear()
  assetCreateUrl.mockClear()
  progressError.mockClear()
})

test('Open with uses the saved SSH alias and never downloads a copy', async () => {
  savedTarget = 'studio'
  expect(fileOpenRoute('remote')).toMatchObject({ kind: 'ssh', target: { host: 'studio' } })
  await openFileAction({ editorId: 'vim' }, target)
  await openFileAction({ editorId: 'cursor' }, target)
  expect(openExternal.mock.calls).toEqual([['cursor://vscode-remote/ssh-remote+studio/work/src/app.ts:1:1']])
  expect(openDesktopFile).not.toHaveBeenCalled()
  expect(openInEditor).not.toHaveBeenCalled()
  expect(assetCreateUrl).not.toHaveBeenCalled()
})

test('desktop Open and Reveal send only the authorized checkout bytes to the viewer', async () => {
  const fetchFile = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('source code'))
  try {
    await openFileAction('open', target)
    await openFileAction('reveal', target)
    expect(assetCreateUrl.mock.calls).toEqual(Array.from({ length: 2 }, () =>
      [target.ctx, { path: '/work/src/app.ts', name: 'app.ts', download: true }]))
    expect(String(fetchFile.mock.calls[0]?.[0])).toBe('https://box.example/api/assets/file.signature')
    expect(fetchFile.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(showLocalFileCopy.mock.calls.map(([name, data, action]) => [name, new TextDecoder().decode(data), action]))
      .toEqual([['app.ts', 'source code', 'open'], ['app.ts', 'source code', 'reveal']])
    expect(openDesktopFile).not.toHaveBeenCalled()
    expect(openInEditor).not.toHaveBeenCalled()
  } finally {
    fetchFile.mockRestore()
  }
})

test('denied, misrouted, and folder download requests never reach the native bridge', async () => {
  const fetchFile = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('source'))
  try {
    await openFileAction('open', { ...target, isFolder: true })
    expect(assetCreateUrl).not.toHaveBeenCalled()
    assetCreateUrl.mockRejectedValueOnce(new Error('File access refused'))
    await openFileAction('open', target)
    expect(progressError).toHaveBeenCalled()
    assetCreateUrl.mockResolvedValueOnce({ relativeUrl: 'https://other.example/api/assets/file.signature', expiresAt: 42 })
    await openFileAction('reveal', target)
    assetCreateUrl.mockImplementationOnce(async () => {
      origin = 'https://different-box.example'
      return { relativeUrl: '/api/assets/file.signature', expiresAt: 42 }
    })
    await openFileAction('reveal', target)
    expect(fetchFile).not.toHaveBeenCalled()
    expect(showLocalFileCopy).not.toHaveBeenCalled()
  } finally {
    fetchFile.mockRestore()
  }
})

test('without a saved SSH route, use the advertised target and recheck permission before opening', async () => {
  expect(fileOpenRoute('remote')).toMatchObject({ kind: 'ssh', target: advertisedTarget })
  permissions = ['host.files.read']
  await openFileAction({ editorId: 'cursor' }, target)
  await openFileAction('open', target)
  expect(openExternal).not.toHaveBeenCalled()
  expect(assetCreateUrl).not.toHaveBeenCalled()
  permissions = ['host.use', 'host.files.read']
  advertisedTarget = undefined
  expect(fileOpenRoute('remote')).toBeNull()
  isReady = false
  savedTarget = 'studio'
  expect(fileOpenRoute('remote')).toBeNull()
})

test('local Open and Reveal require native window permission', async () => {
  isLocal = true
  expect(fileOpenRoute('remote')).toBeNull()
  permissions.push('host.local.window')
  await openFileAction('open', target)
  await openFileAction('reveal', target)
  expect(openDesktopFile.mock.calls).toEqual([['/work/src/app.ts', 'open'], ['/work/src/app.ts', 'reveal']])
  expect(openExternal).not.toHaveBeenCalled()
})

test('desktop browsers can use the advertised SSH target and phone browsers keep their preview', async () => {
  platform = 'web'
  await openFileAction('open', target)
  await openFileAction('reveal', target)
  expect(assetCreateUrl).not.toHaveBeenCalled()
  await openFileAction({ editorId: 'vscode' }, target)
  expect(openExternal.mock.calls).toEqual([['vscode://vscode-remote/ssh-remote+dev%40box.tail.ts.net/work/src/app.ts:1:1']])
  const original = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
  Object.defineProperty(navigator, 'userAgent', { value: 'iPhone', configurable: true })
  try {
    expect(fileOpenRoute('remote')).toBeNull()
  } finally {
    if (original) Object.defineProperty(navigator, 'userAgent', original)
    else Reflect.deleteProperty(navigator, 'userAgent')
  }
})
