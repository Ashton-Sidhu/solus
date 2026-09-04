import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IpcContext } from '@solus/contracts/types'
import { createAssetUrl } from '@solus/server/server/assets'
import {
  faviconCandidatePaths,
  ProjectFaviconResolver,
  type ProjectFaviconRequest,
} from '@solus/workspace-ui/lib/project-favicon'

function request(serverId: string): ProjectFaviconRequest {
  return {
    serverId,
    projectRoot: '/repo',
    origin: `https://${serverId}.example`,
    api: { assetCreateUrl: async () => ({ relativeUrl: '', expiresAt: 0 }) },
    // SAFETY: the resolver only forwards this context to the asset URL cache.
    ctx: { session: {} } as IpcContext,
  }
}

describe('project favicon resolver', () => {
  test('asks the project host for candidates in preference order', async () => {
    const calls: string[] = []
    const resolver = new ProjectFaviconResolver({
      resolve: async ({ path }) => {
        calls.push(path ?? '')
        if (path !== '/repo/favicon.svg') throw new Error('missing')
        return 'https://host.example/api/assets/favicon'
      },
    })

    expect(await resolver.resolve(request('host-a'))).toBe('https://host.example/api/assets/favicon')
    expect(calls).toEqual(['/repo/favicon.ico', '/repo/favicon.svg'])
    expect(faviconCandidatePaths('/repo/')).toEqual([
      '/repo/favicon.ico',
      '/repo/favicon.svg',
      '/repo/favicon.png',
      '/repo/favicon.webp',
      '/repo/favicon.jpg',
      '/repo/favicon.jpeg',
      '/repo/public/favicon.ico',
      '/repo/static/favicon.ico',
      '/repo/apps/web/public/favicon.ico',
    ])
  })

  test('finds a favicon in a monorepo web app', async () => {
    const calls: string[] = []
    const resolver = new ProjectFaviconResolver({
      resolve: async ({ path }) => {
        calls.push(path ?? '')
        if (path !== '/repo/apps/web/public/favicon.ico') throw new Error('missing')
        return 'https://host.example/api/assets/favicon'
      },
    })

    expect(await resolver.resolve(request('host-a'))).toBe('https://host.example/api/assets/favicon')
    expect(calls.at(-1)).toBe('/repo/apps/web/public/favicon.ico')
  })

  test('the host can mint a signed URL for an ico favicon', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'solus-project-favicon-'))
    try {
      const faviconPath = join(projectRoot, 'favicon.ico')
      await writeFile(faviconPath, Buffer.from([0, 0, 1, 0]))
      const result = await createAssetUrl(
        {
          // SAFETY: asset URL authorization reads only the project directories.
          session: { projectPath: projectRoot, workingDirectory: projectRoot },
        } as IpcContext,
        { path: faviconPath },
        { secret: Buffer.alloc(32), now: 1_000 },
      )

      expect(result.relativeUrl).toStartWith('/api/assets/')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('keeps equal project paths on different hosts separate', async () => {
    const calls: string[] = []
    const resolver = new ProjectFaviconResolver({
      resolve: async ({ serverId, path }) => {
        calls.push(`${serverId}:${path}`)
        if (path !== '/repo/favicon.ico') throw new Error('missing')
        return `https://${serverId}.example/favicon`
      },
    })

    expect(await resolver.resolve(request('host-a'))).toBe('https://host-a.example/favicon')
    expect(await resolver.resolve(request('host-b'))).toBe('https://host-b.example/favicon')
    expect(calls).toEqual([
      'host-a:/repo/favicon.ico',
      'host-b:/repo/favicon.ico',
    ])
  })

  test('remembers a missing project instead of probing it again', async () => {
    let calls = 0
    const resolver = new ProjectFaviconResolver({
      resolve: async () => {
        calls++
        throw new Error('missing')
      },
    })
    const input = request('host-a')

    expect(await resolver.resolve(input)).toBeNull()
    expect(await resolver.resolve(input)).toBeNull()
    expect(calls).toBe(faviconCandidatePaths('/repo').length)
  })
})
