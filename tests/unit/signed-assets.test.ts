import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ASSET_URL_TTL_MS,
  createAssetUrl,
  serveAssetToken,
  verifyAssetToken,
} from '@solus/server/server/assets'
import type { IpcContext } from '@solus/contracts/types'

describe('signed host asset URLs', () => {
  let sandbox = ''
  let project = ''
  let outside = ''
  const secret = Buffer.alloc(32, 7)
  const now = 1_700_000_000_000

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'solus-signed-assets-'))
    project = join(sandbox, 'project')
    outside = join(sandbox, 'outside')
    await mkdir(project)
    await mkdir(outside)
  })

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  function ctx(): IpcContext {
    return {
      session: {
        sessionId: 'asset-session',
        workingDirectory: project,
        projectPath: project,
      },
    } as IpcContext
  }

  test('mints a valid token with the configured expiry', async () => {
    const path = join(project, 'image.png')
    await writeFile(path, 'png')
    const result = await createAssetUrl(ctx(), path, { secret, now })
    const token = result.relativeUrl.slice('/api/assets/'.length)

    expect(result.expiresAt).toBe(now + ASSET_URL_TTL_MS)
    expect(verifyAssetToken(token, secret, now)).toEqual({ path: await realpath(path), expiresAt: result.expiresAt })
    const response = await serveAssetToken(token, { method: 'GET' }, { secret, now })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('png')
  })

  test('refuses expired and tampered tokens', async () => {
    const path = join(project, 'image.webp')
    await writeFile(path, 'webp')
    const result = await createAssetUrl(ctx(), path, { secret, now, ttlMs: 100 })
    const token = result.relativeUrl.slice('/api/assets/'.length)
    const last = token.at(-1)
    const tampered = `${token.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`

    expect(verifyAssetToken(token, secret, result.expiresAt)).toBeNull()
    expect(verifyAssetToken(tampered, secret, now)).toBeNull()
  })

  test('refuses a canonical path outside the session project', async () => {
    const path = join(outside, 'escape.png')
    await writeFile(path, 'png')
    await expect(createAssetUrl(ctx(), path, { secret, now })).rejects.toThrow('outside')
  })

  test('refuses an extension outside the asset allowlist', async () => {
    const path = join(project, 'payload.html')
    await writeFile(path, '<script>alert(1)</script>')
    await expect(createAssetUrl(ctx(), path, { secret, now })).rejects.toThrow('not allowed')
  })
})
