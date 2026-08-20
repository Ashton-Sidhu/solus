import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { issueSshBootstrapCredential, resetAuthStateForTests, verifySessionToken } from '@solus/server/server/auth'
import {
  bootstrapDiscoveredServerOverSsh,
  isSshAuthFailure,
  parseSshTarget,
  resolveSshBootstrapTarget,
  SSH_BOOTSTRAP_CREDENTIAL_SCRIPT,
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

  test('finds Solus through the remote account login shell', () => {
    // WHY: Linuxbrew and version managers often add their bin directory only
    // in interactive shell startup. The SSH bootstrap still has to use the CLI
    // that the same account can run in its terminal.
    const directory = mkdtempSync(join(tmpdir(), 'solus-ssh-path-test-'))
    const cliDirectory = join(directory, 'cli bin')
    const cliPath = join(cliDirectory, 'solus')
    const shellPath = join(directory, 'login-shell')
    mkdirSync(cliDirectory)
    writeFileSync(cliPath, `#!/bin/sh
test "$1" = auth
test "$2" = session
test "$3" = create
printf '{"sessionToken":"token"}\\n'
`)
    writeFileSync(shellPath, `#!/bin/sh
test "$1" = -ilc
printf '%s\\n' "$SOLUS_TEST_CLI"
`)
    chmodSync(cliPath, 0o755)
    chmodSync(shellPath, 0o755)

    try {
      const result = spawnSync('/bin/sh', ['-s', '--', 'Test device'], {
        input: SSH_BOOTSTRAP_CREDENTIAL_SCRIPT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin',
          SHELL: shellPath,
          SOLUS_TEST_CLI: cliPath,
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('{"sessionToken":"token"}')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('detects OpenSSH authentication failures', () => {
    expect(isSshAuthFailure('Permission denied (publickey,password).')).toBe(true)
    expect(isSshAuthFailure('Too many authentication failures')).toBe(true)
    expect(isSshAuthFailure('Host key verification failed.')).toBe(false)
  })

  test('SSH-authorized credential issuance creates a normal session token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-auth-test-'))
    process.env.SOLUS_DATA_DIR = dir
    resetAuthStateForTests()
    try {
      const credential = issueSshBootstrapCredential('Solus desktop', 1_770_000_000_000)
      const session = verifySessionToken(credential.sessionToken, 1_770_000_000_000)

      expect(session?.deviceLabel).toBe('Solus desktop')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('SSH-authorized credential issuance allows multiple clients', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-auth-test-'))
    process.env.SOLUS_DATA_DIR = dir
    resetAuthStateForTests()
    try {
      const first = issueSshBootstrapCredential('First desktop', 1_770_000_000_000)
      const second = issueSshBootstrapCredential('Second desktop', 1_770_000_001_000)

      expect(second.sessionToken).not.toBe(first.sessionToken)
      expect(verifySessionToken(first.sessionToken, 1_770_000_001_000)?.deviceLabel).toBe('First desktop')
      expect(verifySessionToken(second.sessionToken, 1_770_000_001_000)?.deviceLabel).toBe('Second desktop')
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
    source: 'tailnet',
  }
}
