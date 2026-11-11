import { describe, expect, test } from 'bun:test'
import { localEditorFileUrl } from '@solus/contracts/local-editor-links'

/**
 * Agents link a file as vscode://file/<path>:<line> or cursor://file/...
 * (pingdotgg/t3code#23486). Solus hands those links to the operating system,
 * which opens the editor on the machine that shows the link. Only the file
 * form passes: an editor's other deep links (prompts, clones, remote windows)
 * act on their own and must stay dead in chat.
 */

const FILE_LINKS = [
  'cursor://file/Users/me/repo/file.md:186',
  'vscode://file/Users/me/repo/file.md:3:7',
  'vscode-insiders://file/Users/me/repo/file.md',
  'vscodium://file/C:/Users/me/repo/file.md:3',
]

const OTHER_LINKS = [
  'cursor://anysphere.cursor-deeplink/prompt?text=hi',
  'vscode://vscode.git/clone?url=https%3A%2F%2Fexample.com%2Frepo.git',
  'vscode://vscode-remote/ssh-remote+example.com/home/user/project',
  'vscode://user@file/Users/me/repo/file.md',
  'cursor://:secret@file/Users/me/repo/file.md',
  'cursor://file:8080/Users/me/repo/file.md',
  'cursor://file',
  'cursor://file/',
  'cursor:file/Users/me/repo/file.md',
  'foo://file/Users/me/repo/file.md',
  'zed://file/Users/me/repo/file.md',
  'javascript:alert(1)',
  './file.md',
  '',
]

describe('local editor file links', () => {
  test('the file form of each known editor is accepted as written', () => {
    for (const href of FILE_LINKS) expect(localEditorFileUrl(href)).toBe(href)
  })

  test('the scheme is lowercased so the operating system finds the editor', () => {
    expect(localEditorFileUrl('VSCode://file/Users/me/repo/file.md:3')).toBe('vscode://file/Users/me/repo/file.md:3')
  })

  test('other editor deep links, user info, ports, empty paths and unknown schemes are refused', () => {
    for (const href of OTHER_LINKS) expect(localEditorFileUrl(href)).toBeNull()
  })

})
