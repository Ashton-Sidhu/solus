import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import {
  changedFilePath,
  extractChangedFilePathsFromMessage,
  toAbsoluteFilePaths,
} from '@solus/workspace-ui/lib/changedFiles'
import { hostPathFrom, locateSessionFile, normalizeHostPath } from '@solus/workspace-ui/lib/session-paths'

// A session works in `web`. It has two session folders beside it, `api` and
// `shared`, and one inside `api`: `api/vendor/sdk` is its own repository
// (docs/plans/codebases.md §8).
const WEB = '/work/web'
const API = { path: '/work/api', name: 'api' }
const SHARED = { path: '/work/shared', name: 'shared' }
const SDK = { path: '/work/api/vendor/sdk', name: 'sdk' }
const roots = { projectPath: WEB, workingDirectory: WEB, sessionFolders: [API, SHARED, SDK] }

function edit(filePath: string): Message {
  return {
    id: 'm1',
    role: 'tool',
    toolName: 'Edit',
    toolStatus: 'completed',
    toolInput: JSON.stringify({ file_path: filePath }),
    content: '',
    timestamp: 0,
  } as Message
}

describe('changed files of a session with session folders', () => {
  test('a file of the working directory is written from it, as before', () => {
    expect(changedFilePath('/work/web/src/app.ts', roots)).toBe('src/app.ts')
  })

  test('a file of a session folder is written from that folder, with the folder in front', () => {
    // Two repositories can each have `src/index.ts`. The folder in front keeps
    // them apart in one list, and it is how the host names the same file.
    expect(changedFilePath('/work/api/src/index.ts', roots)).toBe('../api/src/index.ts')
    expect(changedFilePath('/work/shared/src/index.ts', roots)).toBe('../shared/src/index.ts')
  })

  test('a file of a repository inside a session folder belongs to the inner one: the longest folder wins', () => {
    const file = locateSessionFile('/work/api/vendor/sdk/client.ts', WEB, [API, SHARED, SDK])
    expect(file.folder).toBe(SDK)
    expect(file.path).toBe('client.ts')
    expect(file.sessionPath).toBe('../api/vendor/sdk/client.ts')
    // The order of the folders does not decide it.
    expect(locateSessionFile('/work/api/vendor/sdk/client.ts', WEB, [SDK, API]).folder).toBe(SDK)
    expect(locateSessionFile('/work/api/vendor/other.ts', WEB, [SDK, API]).folder).toBe(API)
  })

  test('a file of the working directory stays there when a session folder is above it', () => {
    // `/work` holds the working directory too, but the working directory is the longer of the two.
    const above = { path: '/work', name: 'work' }
    expect(locateSessionFile('/work/web/src/app.ts', WEB, [above]).folder).toBeNull()
    expect(locateSessionFile('/work/README.md', WEB, [above]).folder).toBe(above)
  })

  test('the host names a session folder file from the working directory, and it is found again', () => {
    expect(locateSessionFile('../api/src/index.ts', WEB, [API, SHARED])).toEqual({
      sessionPath: '../api/src/index.ts',
      folder: API,
      path: 'src/index.ts',
    })
    // A repository inside the working directory has no `..` in front.
    const docs = { path: '/work/web/docs', name: 'docs' }
    expect(locateSessionFile('docs/guide.md', WEB, [docs]).folder).toBe(docs)
    expect(locateSessionFile('src/app.ts', WEB, [docs]).folder).toBeNull()
  })

  test('a folder with the same first letters is not the folder', () => {
    expect(locateSessionFile('/work/api-docs/readme.md', WEB, [API]).folder).toBeNull()
  })

  test('a path outside each folder keeps its absolute form', () => {
    expect(changedFilePath('/tmp/scratch.txt', roots)).toBe('/tmp/scratch.txt')
  })

  test('with no session folders the path is written from the project only', () => {
    expect(changedFilePath('/work/api/src/index.ts', { projectPath: WEB })).toBe('/work/api/src/index.ts')
    expect(changedFilePath('/work/web/src/app.ts', { projectPath: WEB })).toBe('src/app.ts')
  })

  test('a tool call in a session folder gives the session path', () => {
    expect(extractChangedFilePathsFromMessage(edit('/work/api/src/index.ts'), roots)).toEqual(['../api/src/index.ts'])
    expect(extractChangedFilePathsFromMessage(edit('/work/web/src/app.ts'), roots)).toEqual(['src/app.ts'])
  })

  test('a session path opens the real file: no `..` is left in the absolute path', () => {
    expect(toAbsoluteFilePaths(['../api/src/index.ts', 'src/app.ts'], WEB)).toEqual([
      '/work/api/src/index.ts',
      '/work/web/src/app.ts',
    ])
    expect(toAbsoluteFilePaths(['..\\api\\src\\index.ts'], 'C:\\work\\web')).toEqual(['C:\\work\\api\\src\\index.ts'])
  })

  test('Windows folders compare without case, and a folder on a different drive keeps its path', () => {
    const api = { path: 'C:\\Work\\Api', name: 'api' }
    expect(locateSessionFile('c:/work/api/src/Index.ts', 'C:\\Work\\Web', [api])).toMatchObject({
      folder: api,
      path: 'src/Index.ts',
      sessionPath: '../Api/src/Index.ts',
    })
    expect(hostPathFrom('C:\\Work\\Web', 'D:\\Other\\Api')).toBe('D:/Other/Api')
  })

  test('a path is normalized without a change to a clean path', () => {
    expect(normalizeHostPath('/work/web/../api/./src')).toBe('/work/api/src')
    expect(normalizeHostPath('/work/web/src')).toBe('/work/web/src')
    expect(normalizeHostPath('/../x')).toBe('/x')
    expect(normalizeHostPath('../x')).toBe('../x')
  })
})
