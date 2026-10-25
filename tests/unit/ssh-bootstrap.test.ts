import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { issueSshBootstrapCredential, resetAuthStateForTests, verifySessionToken } from '@solus/server/admission/auth'
import {
  askpassEnv,
  askpassHelper,
  bootstrapDiscoveredServerOverSsh,
  isSshAuthFailure,
  parseSshTarget,
  resolveSshBootstrapTarget,
  SSH_BOOTSTRAP_CREDENTIAL_SCRIPT,
  type SshRunOptions,
  windowsCredentialCommand,
  windowsCredentialScript,
} from '@solus/server/transport/ssh-bootstrap'
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

  test('a Windows host is asked again through PowerShell, and only after its shell has no sh', async () => {
    // WHY: Windows OpenSSH runs commands in cmd.exe or PowerShell, which have
    // no `sh`. A POSIX host must never get the PowerShell command, and a
    // Windows host must not stop at cmd.exe's answer.
    const shells: SshRunOptions['shell'][] = []
    const result = await bootstrapDiscoveredServerOverSsh({
      server: discoveredServer(),
      sshTarget: 'ashto@windows-host',
      deviceLabel: 'Solus desktop',
    }, async (options) => {
      shells.push(options.shell)
      // As a real Windows host answers: cmd.exe exits 0 and echoes the piped script.
      if (options.shell === 'sh') return { stdout: SSH_BOOTSTRAP_CREDENTIAL_SCRIPT, stderr: WINDOWS_NO_SH, code: 0 }
      return { stdout: `${JSON.stringify({ sessionToken: 'token', installationId: 'windows-installation', fingerprint: 'abc12345' })}\r\n`, stderr: '', code: 0 }
    })

    expect(shells).toEqual(['sh', 'powershell'])
    expect(result).toEqual({ status: 'connected', credential: { sessionToken: 'token', installationId: 'windows-installation', fingerprint: 'abc12345' } })
  })

  test('a POSIX failure is not retried through PowerShell', async () => {
    const shells: SshRunOptions['shell'][] = []
    const run = bootstrapDiscoveredServerOverSsh({ server: discoveredServer(), sshTarget: 'sidhu@studio-host' }, async (options) => {
      shells.push(options.shell)
      return { stdout: '', stderr: 'Solus CLI not found in the SSH or login-shell PATH.', code: 127 }
    })

    await expect(run).rejects.toThrow('Solus CLI not found in the SSH or login-shell PATH.')
    expect(shells).toEqual(['sh'])
  })

  test('a Windows host without Solus says to install the server there', async () => {
    // WHY: PowerShell's own error for a missing command names no next step.
    const run = bootstrapDiscoveredServerOverSsh({ server: discoveredServer(), sshTarget: 'ashto@windows-host' }, async (options) =>
      options.shell === 'sh' ? { stdout: '', stderr: WINDOWS_NO_SH, code: 1 } : { stdout: '', stderr: '', code: 127 })

    await expect(run).rejects.toThrow('Install the Solus server on this Windows host first')
  })

  test('a Windows host where PowerShell does not start says so, not what cmd.exe printed', async () => {
    const run = bootstrapDiscoveredServerOverSsh({ server: discoveredServer(), sshTarget: 'ashto@windows-host' }, async () =>
      ({ stdout: '', stderr: WINDOWS_NO_SH, code: 1 }))

    await expect(run).rejects.toThrow('This host runs Windows, and Solus could not start PowerShell there over SSH. Pair with a code instead.')
  })

  test('the device label reaches the Windows host as data, never as shell syntax', () => {
    // WHY: the label is typed by the user. cmd.exe, PowerShell, and the
    // cmd.exe that runs solus.cmd each parse quotes and metacharacters, so a
    // label such as `x' ; calc ; '` or `a & calc` must not run a command.
    const label = `Ashton's Mac' ; calc ; 'x" & calc %PATH% |`
    const command = windowsCredentialCommand(label)
    expect(command.slice(0, -1)).toEqual(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    // Both remote shells see only base64 characters.
    expect(command.at(-1)).toMatch(/^[A-Za-z0-9+/=]+$/)

    const script = Buffer.from(command.at(-1) ?? '', 'base64').toString('utf16le')
    expect(script).toBe(windowsCredentialScript(label))
    const labelLine = script.split('\n').find((line) => line.startsWith('$label = ')) ?? ''
    expect(labelLine).toBe(`$label = 'Ashton''s Mac'' ; calc ; ''x  calc PATH'`)
    // Inside the literal, every quote is doubled: none ends it early.
    expect(labelLine.slice("$label = '".length, -1).replaceAll("''", '')).not.toContain("'")
    expect(script).toContain("Join-Path $env:USERPROFILE '.local\\bin\\solus.cmd'")
    expect(script).toContain('& $cli auth session create --json --device-label $label')
  })

  test('the askpass helper on Windows is a .cmd that reads the secret from the environment', () => {
    // WHY: Windows cannot run a `#!/bin/sh` script, and a secret on a command
    // line is visible to every process on the machine.
    const helper = askpassHelper('win32')
    expect(helper.name).toBe('ssh-askpass.cmd')
    expect(helper.content).not.toContain('SOLUS_SSH_AUTH_SECRET%')
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)\r\n/.exec(helper.content)?.[1] ?? ''
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('$env:SOLUS_SSH_AUTH_SECRET')

    expect(askpassEnv('win32', 'C:\\Temp\\ssh-askpass.cmd', 'pass', {})).toEqual({
      SSH_ASKPASS: 'C:\\Temp\\ssh-askpass.cmd',
      SSH_ASKPASS_REQUIRE: 'force',
      SOLUS_SSH_AUTH_SECRET: 'pass',
    })
  })

  // Runs the POSIX helper with /bin/sh, which Windows does not have.
  test.skipIf(process.platform === 'win32')('the askpass helper on POSIX prints the secret from the environment and needs a DISPLAY', () => {
    const helper = askpassHelper('darwin')
    expect(helper.name).toBe('ssh-askpass.sh')
    expect(helper.content.startsWith('#!/bin/sh\n')).toBe(true)
    const result = spawnSync('/bin/sh', ['-c', helper.content], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SOLUS_SSH_AUTH_SECRET: "a'b & $c" } })
    expect(result.stdout).toBe("a'b & $c\n")

    expect(askpassEnv('linux', '/tmp/ssh-askpass.sh', 'pass', {})).toMatchObject({ DISPLAY: 'solus' })
    expect(askpassEnv('linux', '/tmp/ssh-askpass.sh', 'pass', { DISPLAY: ':0' }).DISPLAY).toBeUndefined()
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

  // Runs a #!/bin/sh fake CLI through a POSIX login shell.
  test.skipIf(process.platform === 'win32')('finds Solus through the remote account login shell', () => {
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

const WINDOWS_NO_SH = "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"

function discoveredServer(): DiscoveredServer {
  return {
    host: '100.64.0.8',
    port: 3000,
    name: 'solus-unconfigured-test-host.invalid',
    installationId: 'remote-installation',
    source: 'tailnet',
  }
}
