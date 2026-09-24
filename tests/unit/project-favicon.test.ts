import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IpcContext } from '@solus/contracts/types'
import { createAssetUrl, findAssetUrl } from '@solus/server/server/assets'
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
    api: {
      assetCreateUrl: async () => ({ relativeUrl: '', expiresAt: 0 }),
      assetFindUrl: async () => null,
    },
    // SAFETY: the resolver only forwards this context to the asset URL cache.
    ctx: { session: {} } as IpcContext,
  }
}

/** A host with no favicon anywhere. Counts the requests it answers. */
function hostWithoutFavicon() {
  const host = {
    finds: 0,
    find: async () => { host.finds++; return null },
    resolve: async (): Promise<string> => { throw new Error('not used') },
  }
  return host
}

describe('project favicon resolver', () => {
  test('reuses a missing result after the renderer reloads', async () => {
    // WHY: a full renderer reload creates a new resolver. Session storage keeps
    // a known miss from becoming another host request on every reload.
    const values = new Map<string, string>()
    const storage = {
      get length() { return values.size },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      key: (index: number) => [...values.keys()][index] ?? null,
    }
    const host = hostWithoutFavicon()

    expect(await new ProjectFaviconResolver(host, storage, () => 1_000)
      .resolve(request('host-a'))).toBeNull()
    expect(await new ProjectFaviconResolver(host, storage, () => 2_000)
      .resolve(request('host-a'))).toBeNull()
    expect(host.finds).toBe(1)
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
      find: async ({ serverId, paths }) => {
        calls.push(serverId)
        return { path: paths[0], url: `https://${serverId}.example/favicon` }
      },
      resolve: async ({ serverId }) => `https://${serverId}.example/favicon`,
    })

    expect(await resolver.resolve(request('host-a'))).toBe('https://host-a.example/favicon')
    expect(await resolver.resolve(request('host-b'))).toBe('https://host-b.example/favicon')
    expect(calls).toEqual(['host-a', 'host-b'])
  })

  test('remembers a missing project instead of asking again', async () => {
    const host = hostWithoutFavicon()
    const resolver = new ProjectFaviconResolver(host)
    const input = request('host-a')

    expect(await resolver.resolve(input)).toBeNull()
    expect(await resolver.resolve(input)).toBeNull()
    expect(host.finds).toBe(1)
  })

  test('a host that does not answer is asked again, not remembered as missing', async () => {
    // WHY: a dropped connection says nothing about the project. Recording it as
    // "no favicon" would hide a real favicon for the rest of the session.
    let finds = 0
    const resolver = new ProjectFaviconResolver({
      find: async ({ paths }) => {
        finds++
        if (finds === 1) throw new Error('disconnected')
        return { path: paths[1], url: 'https://host.example/favicon' }
      },
      resolve: async () => 'https://host.example/favicon',
    })

    expect(await resolver.resolve(request('host-a'))).toBeNull()
    expect(await resolver.resolve(request('host-a'))).toBe('https://host.example/favicon')
  })

  test('a host with assetFindUrl answers every candidate in one request', async () => {
    // WHY: probing one path per request cost a project without a favicon nine
    // host round trips per boot, each one a network trip for a remote client.
    const finds: string[][] = []
    let resolves = 0
    const resolver = new ProjectFaviconResolver({
      find: async ({ paths }) => {
        finds.push(paths)
        return paths.includes('/repo/favicon.svg')
          ? { path: '/repo/favicon.svg', url: 'https://host.example/favicon' }
          : null
      },
      resolve: async () => { resolves++; throw new Error('not used') },
    })

    expect(await resolver.resolve(request('host-a'))).toBe('https://host.example/favicon')
    expect(finds).toEqual([faviconCandidatePaths('/repo')])
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
    expect(resolves).toBe(0)
  })

  test('the host serves the first candidate that exists in the project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'solus-project-favicon-'))
    try {
      await writeFile(join(projectRoot, 'favicon.svg'), '<svg/>')
      await writeFile(join(projectRoot, 'favicon.png'), Buffer.from([137, 80, 78, 71]))
      // SAFETY: asset URL authorization reads only the project directories.
      const ctx = { session: { projectPath: projectRoot, workingDirectory: projectRoot } } as IpcContext
      const options = { secret: Buffer.alloc(32), now: 1_000 }
      const found = await findAssetUrl(ctx, { paths: faviconCandidatePaths(projectRoot) }, options)
      const outside = await findAssetUrl(ctx, { paths: ['/etc/hosts'] }, options)

      expect(found?.path).toBe(join(projectRoot, 'favicon.svg'))
      expect(found?.relativeUrl).toStartWith('/api/assets/')
      expect(outside).toBeNull()
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
