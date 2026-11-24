import { beforeEach, expect, mock, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import type { Permission } from '@solus/contracts/permissions'

let isLocal = false
let permissions: Permission[] = []
let advertisedTarget: { host: string; user: string } | undefined
let savedTarget: string | undefined
let isReady = true
let platform = 'darwin'

const openExternal = mock(async (_url: string) => true)
const openDesktopFile = mock(async (_path: string, _action: 'open' | 'reveal') => true)
const openInEditor = mock(async () => true)
const tools = { state: 'ready', value: { editors: [{ id: 'cursor', name: 'Cursor', isTerminal: false }] } }
const fileActionsDirectory = `${import.meta.dir}/../../packages/workspace-ui/src/components/files/lib`
mock.module(Bun.resolveSync('@solus/client-core/host-policy', fileActionsDirectory), () => ({ hostPolicy: { isClientMachine: () => isLocal } }))
mock.module(Bun.resolveSync('@solus/client-core/local-api', fileActionsDirectory), () => ({ localApi: { getPlatform: () => platform, openExternal } }))
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
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error: mock(() => {}) } }))

const { fileOpenRoute, openFileAction } = await import('@solus/workspace-ui/components/files/lib/file-open-actions')
const target = {
  serverId: 'remote', cwd: '/work', path: 'src/app.ts',
  api: { openDesktopFile, openInEditor }, ctx: {} as IpcContext,
}

beforeEach(() => {
  isLocal = false
  isReady = true
  platform = 'darwin'
  permissions = ['host.use', 'host.files.read']
  advertisedTarget = { host: 'box.tail.ts.net', user: 'dev' }
  savedTarget = undefined
  openExternal.mockClear()
  openDesktopFile.mockClear()
  openInEditor.mockClear()
})

test('the viewer’s saved SSH alias takes priority and only editor choices reach the viewer shell', async () => {
  savedTarget = 'studio'
  expect(fileOpenRoute('remote')).toMatchObject({ kind: 'ssh', target: { host: 'studio' } })
  await openFileAction('open', target)
  await openFileAction('reveal', target)
  await openFileAction({ editorId: 'vim' }, target)
  await openFileAction({ editorId: 'cursor' }, target)
  expect(openExternal.mock.calls).toEqual([['cursor://vscode-remote/ssh-remote+studio/work/src/app.ts:1:1']])
  expect(openDesktopFile).not.toHaveBeenCalled()
  expect(openInEditor).not.toHaveBeenCalled()
})

test('without a saved SSH route, use the advertised target and recheck permission before opening', async () => {
  expect(fileOpenRoute('remote')).toMatchObject({ kind: 'ssh', target: advertisedTarget })
  permissions = ['host.files.read']
  await openFileAction({ editorId: 'cursor' }, target)
  expect(openExternal).not.toHaveBeenCalled()
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
