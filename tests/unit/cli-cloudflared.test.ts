import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installCloudflared,
  managedCloudflaredPath,
  type ReleaseAsset,
} from '../../apps/cli/src/lib/cloudflared'

// `solus connect` must not trust an unverified network download. These tests pin
// the checksum and staging rules that make installation safe to retry.

describe('the CLI cloudflared installer', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-cli-cloudflared-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('installs a verified binary into the Solus data directory', async () => {
    const bytes = Buffer.from('#!/bin/sh\necho cloudflared version\n')
    const asset: ReleaseAsset = {
      url: 'https://downloads.test/cloudflared',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      archive: 'binary',
    }
    let validations = 0
    const installed = await installCloudflared({
      dataDir,
      platform: 'linux',
      arch: 'x64',
      asset,
      fetchImpl: async () => new Response(bytes),
      validateBinary: async (path) => {
        validations++
        expect(readFileSync(path)).toEqual(bytes)
      },
    })

    expect(installed).toBe(managedCloudflaredPath(dataDir, 'linux'))
    expect(existsSync(installed)).toBe(true)
    expect(validations).toBe(1)
    expect(await installCloudflared({
      dataDir,
      platform: 'linux',
      arch: 'x64',
      asset,
      fetchImpl: async () => { throw new Error('must not download twice') },
      validateBinary: async () => { throw new Error('must not validate twice') },
    })).toBe(installed)
  })

  test('does not activate a download with the wrong checksum', async () => {
    const asset: ReleaseAsset = {
      url: 'https://downloads.test/cloudflared',
      sha256: '0'.repeat(64),
      archive: 'binary',
    }
    await expect(installCloudflared({
      dataDir,
      platform: 'linux',
      arch: 'x64',
      asset,
      fetchImpl: async () => new Response('tampered'),
      validateBinary: async () => {},
    })).rejects.toThrow('checksum')

    expect(existsSync(managedCloudflaredPath(dataDir, 'linux'))).toBe(false)
  })
})
