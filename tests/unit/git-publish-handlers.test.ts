import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SolusServer } from '../../src/main/server/server'
import { registerGitPublishHandlers } from '../../src/main/server/handlers/git-publish-handlers'
import type { IpcContext } from '../../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'solus-git-publish-handlers-'))
  temporaryDirectories.push(dir)
  return dir
}

function ctxForCwd(cwd: string): IpcContext {
  // SAFETY: the handler under test reads only `session.projectPath` and
  // `session.workingDirectory` from this context.
  return { session: { projectPath: cwd, workingDirectory: cwd } } as unknown as IpcContext
}

function buildServer(): SolusServer {
  const server = new SolusServer()
  registerGitPublishHandlers(server)
  return server
}

describe('git-publish-handlers', () => {
  test('gitRepositoryStatus reports no repository for a plain temporary folder', async () => {
    const server = buildServer()
    const dir = await tempProjectDir()
    const status = await server.handle('gitRepositoryStatus', [dir])
    expect(status.isRepository).toBe(false)
  })

  test('gitInitRepository initializes a real repository without committing, and refuses to run twice', async () => {
    const server = buildServer()
    const dir = await tempProjectDir()

    const result = await server.handle('gitInitRepository', [dir])
    expect(result.defaultBranch).toBeTruthy()

    const status = await server.handle('gitRepositoryStatus', [dir])
    expect(status).toEqual({
      isRepository: true,
      hasCommits: false,
      branch: result.defaultBranch,
      primaryRemoteName: null,
      primaryRemoteUrl: null,
    })

    await expect(server.handle('gitInitRepository', [dir])).rejects.toThrow('already a Git repository')
  })

  test('gitInitRepository rejects a session with no working directory', async () => {
    const server = buildServer()
    await expect(server.handle('gitInitRepository', ['~'])).rejects.toThrow('No folder is open')
  })

  test('githubPublishRepository rejects a session with no working directory', async () => {
    const server = buildServer()
    await expect(server.handle('githubPublishRepository', [
      ctxForCwd('~'),
      { owner: 'acme', name: 'widgets', private: true, protocol: 'https' },
    ])).rejects.toThrow('No folder is open')
  })

  test('githubPublishRepository requires Initialize Git to have run first', async () => {
    const server = buildServer()
    const dir = await tempProjectDir()
    // Not a repository yet — publish must not attempt to reach GitHub.
    await expect(server.handle('githubPublishRepository', [
      ctxForCwd(dir),
      { owner: 'acme', name: 'widgets', private: true, protocol: 'https' },
    ])).rejects.toThrow(/Connect GitHub|Initialize Git/)
  })
})
