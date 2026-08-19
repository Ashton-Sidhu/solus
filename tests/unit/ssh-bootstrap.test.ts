import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { issueSshBootstrapCredential, getOwnershipState, resetAuthStateForTests, verifySessionToken } from '@solus/server/server/auth'
import {
  bootstrapDiscoveredServerOverSsh,
  isSshAuthFailure,
  parseSshTarget,
  resolveSshBootstrapTarget,
  type SshRunOptions,
} from '@solus/server/server/ssh-bootstrap'
import type { DiscoveredServer } from '@solus/contracts/types'

const originalDataDir = process.env.SOLUS_DATA_DIR

afterEach(() => {
  process.env.SOLUS_DATA_DIR = originalDataDir
  resetAuthStateForTests()
})

describe('SSH bootstrap', () => {
  test('asks for an SSH target when discovery cannot prove one from SSH config', () => {
    const result = resolveSshBootstrapTarget(discoveredServer())

    expect(result.status).toBe('needs-target')
    if (result.status === 'needs-target') {
      expect(result.defaultTarget).toContain('@solus-unconfigured-test-host.invalid')
      expect(result.message).toContain('solus-unconfigured-test-host.invalid')
    }
  })

  test('parses user targets with optional ports', () => {
    expect(parseSshTarget('sidhu@studio-host')).toEqual({ destination: 'sidhu@studio-host' })
    expect(parseSshTarget('sidhu@studio-host:2222')).toEqual({ destination: 'sidhu@studio-host', port: 2222 })
  })

  test('turns recognized batch-mode SSH auth failure into a local prompt request', async () => {
    const calls: SshRunOptions[] = []
    const result = await bootstrapDiscoveredServerOverSsh({
      server: discoveredServer(),
      sshTarget: 'sidhu@studio-host',
      deviceLabel: 'Solus desktop',
    }, async (options) => {
      calls.push(options)
      return {
        stdout: '',
        stderr: 'Permission denied (publickey,password).',
        code: 255,
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      batchMode: true,
      deviceLabel: 'Solus desktop',
    })
    expect(calls[0].authSecret).toBeUndefined()
    expect(result).toEqual({
      status: 'needs-auth',
      sshTarget: 'sidhu@studio-host',
      attempt: 1,
      message: 'SSH authentication failed for sidhu@studio-host.',
    })
  })

  test('retries with askpass secret only after local prompt supplies one', async () => {
    const calls: SshRunOptions[] = []
    const result = await bootstrapDiscoveredServerOverSsh({
      server: discoveredServer(),
      sshTarget: 'sidhu@studio-host',
      authSecret: 'entered-passphrase',
      attempt: 1,
      deviceLabel: 'Solus desktop',
    }, async (options) => {
      calls.push(options)
      return {
        stdout: `${JSON.stringify({
          sessionToken: 'token',
          installationId: 'remote-installation',
          fingerprint: 'abc12345',
        })}\n`,
        stderr: '',
        code: 0,
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      batchMode: false,
      authSecret: 'entered-passphrase',
    })
    expect(result).toEqual({
      status: 'connected',
      credential: {
        sessionToken: 'token',
        installationId: 'remote-installation',
        fingerprint: 'abc12345',
      },
    })
  })

  test('detects OpenSSH authentication failures', () => {
    expect(isSshAuthFailure('Permission denied (publickey,password).')).toBe(true)
    expect(isSshAuthFailure('Too many authentication failures')).toBe(true)
    expect(isSshAuthFailure('Host key verification failed.')).toBe(false)
  })

  test('SSH-authorized credential issuance claims an unclaimed server and creates a normal session token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-auth-test-'))
    process.env.SOLUS_DATA_DIR = dir
    resetAuthStateForTests()
    try {
      const credential = issueSshBootstrapCredential('Solus desktop', 1_770_000_000_000)
      const session = verifySessionToken(credential.sessionToken, 1_770_000_000_000)

      expect(session?.deviceLabel).toBe('Solus desktop')
      expect(credential.ownerDeviceId).toBe(session?.deviceId)
      expect(credential.claimedAt).toBe(1_770_000_000_000)
      expect(getOwnershipState()).toEqual({
        owned: {
          ownerDeviceId: session?.deviceId,
          claimedAt: 1_770_000_000_000,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('SSH-authorized credential issuance allows another client after the server is owned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-auth-test-'))
    process.env.SOLUS_DATA_DIR = dir
    resetAuthStateForTests()
    try {
      const first = issueSshBootstrapCredential('First desktop', 1_770_000_000_000)
      const ownership = getOwnershipState()
      const second = issueSshBootstrapCredential('Second desktop', 1_770_000_001_000)

      expect(second.sessionToken).not.toBe(first.sessionToken)
      expect(verifySessionToken(first.sessionToken, 1_770_000_001_000)?.deviceLabel).toBe('First desktop')
      expect(verifySessionToken(second.sessionToken, 1_770_000_001_000)?.deviceLabel).toBe('Second desktop')
      expect(second.ownerDeviceId).toBeUndefined()
      expect(second.claimedAt).toBeUndefined()
      expect(getOwnershipState()).toEqual(ownership)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function discoveredServer(): DiscoveredServer {
  return {
    host: '100.64.0.8',
    port: 3000,
    name: 'solus-unconfigured-test-host.invalid',
    installationId: 'remote-installation',
    claimable: true,
    source: 'tailnet',
  }
}
