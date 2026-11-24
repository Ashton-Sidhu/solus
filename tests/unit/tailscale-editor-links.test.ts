import { expect, test, mock } from 'bun:test'
import { remoteEditorLink } from '../../packages/workspace-ui/src/lib/remote-editor-link'
import { remoteEditorFileUrl } from '@solus/contracts/local-editor-links'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; this code reaches the database through the host's installation id (admission/auth.ts).
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { sshTargetFromStatus, tailscaleSshFromPrefs } = await import('../../packages/server/src/host/ssh-target')

const target = { host: 'box.tail.ts.net', user: 'dev' }

test('remote editor links preserve the SSH destination and encode path segments', () => {
  expect(remoteEditorLink('vscode', target, '/home/dev/my project/a+b.ts'))
    .toBe('vscode://vscode-remote/ssh-remote+dev%40box.tail.ts.net/home/dev/my%20project/a%2Bb.ts')
  expect(remoteEditorLink('cursor', target, '/work/app'))
    .toBe('cursor://vscode-remote/ssh-remote+dev%40box.tail.ts.net/work/app')
  expect(remoteEditorLink('zed', target, '/work/app'))
    .toBe('zed://ssh/dev@box.tail.ts.net/work/app')
  expect(remoteEditorLink('vim', target, '/work/app')).toBeNull()
  expect(remoteEditorLink('vscode', target, 'relative/path')).toBeNull()
  for (const editor of ['vscode', 'cursor', 'zed'] as const) {
    expect(remoteEditorFileUrl(remoteEditorLink(editor, target, '/work/app')!)).not.toBeNull()
  }
  expect(remoteEditorFileUrl('zed://ssh/user:secret@box.tail.ts.net/work')).toBeNull()
  expect(remoteEditorFileUrl('vscode://vscode-remote/ssh-remote+dev%40box.tail.ts.net/work?cmd=run')).toBeNull()
})

test('the host advertises a MagicDNS target only when SSH works', () => {
  const status = { Self: { DNSName: 'box.tail.ts.net.', TailscaleIPs: ['100.100.1.2'] } }
  expect(sshTargetFromStatus(status, 'dev', true, false)).toEqual(target)
  expect(sshTargetFromStatus(status, 'dev', false, true)).toEqual(target)
  expect(sshTargetFromStatus(status, 'dev', false, false)).toBeUndefined()
  expect(sshTargetFromStatus({ Self: { TailscaleIPs: ['100.100.1.2'] } }, 'dev', true, false)).toBeUndefined()
})

test('Tailscale SSH requires both prefs', () => {
  expect(tailscaleSshFromPrefs({ RunSSH: true, WantRunning: true })).toBe(true)
  expect(tailscaleSshFromPrefs({ RunSSH: true, WantRunning: false })).toBe(false)
  expect(tailscaleSshFromPrefs({ RunSSH: true })).toBe(false)
})

test('a viewer opens an SSH alias as a file or as a folder', () => {
  const alias = { host: 'studio', user: 'dev' }
  const file = 'vscode://vscode-remote/ssh-remote+dev%40studio/work/a%20b.ts:1:1'
  const folder = 'vscode://vscode-remote/ssh-remote+dev%40studio/work/src?windowId=_blank'
  expect(remoteEditorLink('vscode', alias, '/work/a b.ts', 'file')).toBe(file)
  expect(remoteEditorLink('vscode', alias, '/work/src', 'folder')).toBe(folder)
  expect(remoteEditorFileUrl(file)).toBe(file)
  expect(remoteEditorFileUrl(folder)).toBe(folder)
})
