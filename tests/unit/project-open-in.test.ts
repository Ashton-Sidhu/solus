import { expect, test } from 'bun:test'
import type { DetectedEditor } from '@solus/contracts/types'
import { editorFolders, editorFoldersTooltip, openInTarget, parseOpenInTarget } from '../../packages/workspace-ui/src/components/project-panel/lib/open-in'

const editors: DetectedEditor[] = [
  { id: 'zed', name: 'Zed', isTerminal: false, binPath: null },
  { id: 'cursor', name: 'Cursor', isTerminal: false, binPath: '/bin/cursor' },
]

test('an explicit choice wins over the Settings default, including Terminal', () => {
  expect(openInTarget('zed', 'cursor', editors)).toBe('zed')
  expect(openInTarget('terminal', 'cursor', editors)).toBe('terminal')
})

test('a missing editor falls back to an installed default or Terminal', () => {
  expect(openInTarget('vscode', 'cursor', editors)).toBe('cursor')
  expect(openInTarget('vscode', 'vscode', editors)).toBe('terminal')
  expect(openInTarget('zed', 'cursor', [])).toBe('terminal')
})

test('the first use honors an installed Settings default and always offers Terminal', () => {
  expect(openInTarget(null, 'cursor', editors)).toBe('cursor')
  expect(openInTarget(null, null, editors)).toBe('terminal')
})

test('stored choices accept known apps and reject invalid data', () => {
  expect(parseOpenInTarget('zed')).toBe('zed')
  expect(parseOpenInTarget('terminal')).toBe('terminal')
  expect(parseOpenInTarget('missing-app')).toBeNull()
  expect(parseOpenInTarget(null)).toBeNull()
})

// WHY: a session in a codebase works in more than one folder. "Open in" must open the codebase, not only the working folder.
test('an editor that holds many folders in one window opens every folder of the session', () => {
  const folders = editorFolders({ workingFolder: '/code/solus', otherFolders: ['/code/solus-cloud', '/code/infra'], editorId: 'zed', isRemote: false })
  expect(folders).toEqual({ paths: ['/code/solus', '/code/solus-cloud', '/code/infra'], leftOut: 0 })
  expect(editorFoldersTooltip(folders, { editorName: 'Zed', isRemote: false })).toBe('Opens solus, solus-cloud, infra')
})

// A container and a task folder hold their repositories: the editor opens the one folder, not each repository again.
test('a folder inside the working folder is not opened a second time', () => {
  const folders = editorFolders({ workingFolder: '/tasks/fix-login', otherFolders: ['/tasks/fix-login/api', '/tasks/fix-login/web/'], editorId: 'vscode', isRemote: false })
  expect(folders).toEqual({ paths: ['/tasks/fix-login'], leftOut: 0 })
  expect(editorFoldersTooltip(folders, { editorName: 'VS Code', isRemote: false })).toBeUndefined()
})

// An SSH link names one folder, and a JetBrains IDE opens each folder as its own project: the row says what it leaves out.
test('a remote host and a one-folder editor open the working folder and say so', () => {
  const remote = editorFolders({ workingFolder: '/srv/solus', otherFolders: ['/srv/solus-cloud'], editorId: 'zed', isRemote: true })
  expect(remote).toEqual({ paths: ['/srv/solus'], leftOut: 1 })
  expect(editorFoldersTooltip(remote, { editorName: 'Zed', isRemote: true })).toBe('Opens solus only: a link to a different host opens one folder. The folders menu opens the others.')
  const jetbrains = editorFolders({ workingFolder: '/code/solus', otherFolders: ['/code/solus-cloud'], editorId: 'intellij', isRemote: false })
  expect(jetbrains).toEqual({ paths: ['/code/solus'], leftOut: 1 })
  expect(editorFoldersTooltip(jetbrains, { editorName: 'IntelliJ IDEA', isRemote: false })).toBe('Opens solus only: IntelliJ IDEA opens one folder in a window. The folders menu opens the others.')
})
