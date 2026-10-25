import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { reserveLoopbackPort, waitForHttpReady, type HelperProcess, type HelperSpawner } from '../devices/device-helpers'
import type { DeviceCommandOptions, DeviceCommandResult, DeviceCommandRunner } from '../devices/device-process'
import { resolveHomePath } from './paths'

/**
 * The one owner of the `ssh` command (docs/plans/host-routes.md D8). Every
 * process Solus starts with `ssh` comes from here: scripts sent on stdin,
 * loopback forwards, and the `ssh -G` check.
 */

export const SSH_CONNECT_TIMEOUT_SECONDS = 10

/** Options for an `ssh` that Solus does not start here, such as git's `GIT_SSH_COMMAND`. */
export function sshConnectionOptions(batchMode = true): string[] {
  return [
    '-o', `BatchMode=${batchMode ? 'yes' : 'no'}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
  ]
}

/** One SSH destination. `destination` is `host` or `user@host`; it never starts with `-`. */
export interface SshTarget {
  destination: string
  port?: number
  identityFile?: string
}

/** Single-quote one argument for the remote POSIX shell. */
export const quoteRemoteArg = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

interface ConnectionArgsOptions {
  batchMode?: boolean
  acceptNewHostKey?: boolean
  extra?: readonly string[]
}

/**
 * The options for one connection, then `--` and the destination. Host-key
 * checks stay on: a new key is accepted only when the caller asks, and a
 * changed key always fails.
 */
export function sshArgs(target: SshTarget, options: ConnectionArgsOptions = {}): string[] {
  if (target.destination.startsWith('-') || /\s/.test(target.destination)) throw new Error('The SSH target is not valid.')
  return [
    '-o', `BatchMode=${options.batchMode === false ? 'no' : 'yes'}`,
    ...(options.acceptNewHostKey ? ['-o', 'StrictHostKeyChecking=accept-new'] : []),
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.identityFile ? ['-i', resolveHomePath(target.identityFile), '-o', 'IdentitiesOnly=yes'] : []),
    ...(options.extra ?? []),
    '--',
    target.destination,
  ]
}

const ASKPASS_SCRIPT = `#!/bin/sh
if [ "\${SOLUS_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\\n" "$SOLUS_SSH_AUTH_SECRET"
  exit 0
fi
printf 'Solus ssh-askpass invoked without SOLUS_SSH_AUTH_SECRET.\\n' >&2
exit 1
`

/** The askpass helper: the file ssh runs to read the secret. */
export interface AskpassHelper {
  name: string
  content: string
}

/** Prints SOLUS_SSH_AUTH_SECRET as UTF-8, whatever the console code page is. */
const WINDOWS_ASKPASS_SCRIPT = [
  "if ($null -eq $env:SOLUS_SSH_AUTH_SECRET) { [Console]::Error.WriteLine('Solus ssh-askpass invoked without SOLUS_SSH_AUTH_SECRET.'); exit 1 }",
  '$stdout = [Console]::OpenStandardOutput()',
  "$bytes = [Text.UTF8Encoding]::new($false).GetBytes($env:SOLUS_SSH_AUTH_SECRET + \"`n\")",
  '$stdout.Write($bytes, 0, $bytes.Length)',
  '$stdout.Flush()',
  'exit 0',
].join('\n')

/**
 * The askpass helper for this platform. It prints the secret from
 * SOLUS_SSH_AUTH_SECRET, so the secret is never on a command line or in a file.
 * Windows cannot run a `#!/bin/sh` script: there it is a `.cmd` that runs a
 * PowerShell script given as `-EncodedCommand`. cmd.exe never expands the
 * secret, so `&`, `|`, `^`, and `%` in it are safe, and the execution policy,
 * which applies to `.ps1` files, does not stop it.
 */
export function askpassHelper(platform: NodeJS.Platform): AskpassHelper {
  if (platform !== 'win32') return { name: 'ssh-askpass.sh', content: ASKPASS_SCRIPT }
  const encoded = Buffer.from(WINDOWS_ASKPASS_SCRIPT, 'utf16le').toString('base64')
  return {
    name: 'ssh-askpass.cmd',
    content: `@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}\r\nexit /b %ERRORLEVEL%\r\n`,
  }
}

/** What ssh needs to ask the helper at `helperPath` for the secret. */
export function askpassEnv(platform: NodeJS.Platform, helperPath: string, secret: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const askpass: NodeJS.ProcessEnv = {
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: 'force',
    SOLUS_SSH_AUTH_SECRET: secret,
  }
  // OpenSSH on POSIX uses askpass only with a DISPLAY. Windows OpenSSH has no such rule.
  if (platform !== 'win32' && !env.DISPLAY) askpass.DISPLAY = 'solus'
  return askpass
}

/** Write the askpass helper to a new private directory. Windows has no execute bit: the `.cmd` extension makes it runnable. */
async function writeAskpassHelper(platform: NodeJS.Platform): Promise<{ directory: string; path: string }> {
  const helper = askpassHelper(platform)
  const directory = await mkdtemp(join(tmpdir(), 'solus-ssh-askpass-'))
  const path = join(directory, helper.name)
  if (platform === 'win32') {
    await writeFile(path, helper.content)
  } else {
    await writeFile(path, helper.content, { mode: 0o700 })
    await chmod(path, 0o700)
  }
  return { directory, path }
}

export interface SshRunOptions {
  /**
   * The remote command that reads the script on stdin. It is Solus code, never
   * user input. The default runs the script with the remote `sh`.
   */
  command?: string
  /** A password or passphrase. ssh reads it once through askpass. Without it, ssh never prompts. */
  authSecret?: string
  /** Accept the key of a host this machine has not seen. A changed key still fails. */
  acceptNewHostKey?: boolean
  timeoutMs?: number
}

export interface SshClientDeps {
  run: DeviceCommandRunner
  spawn: HelperSpawner
  reservePort?: () => Promise<number>
  fetch?: typeof fetch
}

const DEFAULT_REMOTE_COMMAND = 'sh -s --'
const RUN_TIMEOUT_MS = 30_000
const FORWARD_READY_MS = 20_000

/** A loopback forward to a port on an SSH host. Only its captured PID is ever stopped. */
export class SshForward {
  /** Resolves with the ssh exit code when the forward ends. */
  readonly exited: Promise<number | null>

  constructor(private readonly process: HelperProcess, readonly localPort: number, readonly remotePort: number) {
    this.exited = process.exited
  }

  /** Stop the ssh process this forward started. */
  close(): void {
    this.process.kill()
  }
}

export class SshClient {
  constructor(private readonly deps: SshClientDeps) {}

  /**
   * Run `script` on the host. The script goes on stdin and each argument is
   * quoted for the remote shell, so no path or argument becomes shell text.
   * An undefined script sends no stdin.
   */
  async run(target: SshTarget, script: string | undefined, args: readonly string[], options: SshRunOptions = {}): Promise<DeviceCommandResult> {
    const remote = [options.command ?? DEFAULT_REMOTE_COMMAND, ...args.map(quoteRemoteArg)].join(' ')
    const askpass = options.authSecret ? await writeAskpassHelper(process.platform) : null
    try {
      // askpass answers with the same secret each time, so a second prompt cannot succeed.
      const connection = sshArgs(target, { batchMode: !askpass, acceptNewHostKey: options.acceptNewHostKey === true, extra: askpass ? ['-o', 'NumberOfPasswordPrompts=1'] : [] })
      const runOptions: DeviceCommandOptions = { timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS }
      if (script !== undefined) runOptions.stdin = script
      if (askpass) runOptions.env = { ...process.env, ...askpassEnv(process.platform, askpass.path, options.authSecret ?? '', process.env) }
      return await this.deps.run('ssh', [...connection, remote], runOptions)
    } finally {
      if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Forward a free loopback port here to `remotePort` on the host's loopback.
   * With `readyPath`, wait until an HTTP GET of that path answers through the
   * forward; when it does not, close the forward and throw. With
   * `preferredLocalPort`, use that port here when it is free.
   */
  async forward(target: SshTarget, remotePort: number, readyPath?: string, preferredLocalPort?: number): Promise<SshForward> {
    // A forward opened again keeps its port when it is still free, so the route a client saved stays the same.
    const localPort = preferredLocalPort && await isLoopbackPortFree(preferredLocalPort) ? preferredLocalPort : await (this.deps.reservePort ?? reserveLoopbackPort)()
    const child = this.deps.spawn('ssh', sshArgs(target, { extra: ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`] }), process.env)
    const forward = new SshForward(child, localPort, remotePort)
    if (readyPath === undefined) return forward
    let alive = true
    void forward.exited.then(() => { alive = false })
    if (!(await waitForHttpReady(`http://127.0.0.1:${localPort}${readyPath}`, FORWARD_READY_MS, this.deps.fetch ?? fetch, () => alive))) {
      forward.close()
      throw new Error('The SSH forward did not answer.')
    }
    return forward
  }

  /** Does the target resolve to this machine? Reads `ssh -G`; makes no connection. */
  async resolvesToThisMachine(target: SshTarget): Promise<boolean> {
    const result = await this.deps.run('ssh', ['-G', ...sshArgs(target).slice(0, -2), target.destination], { timeoutMs: 5_000 })
    if (result.code !== 0) return false
    const resolved = /^hostname\s+(\S+)/m.exec(result.stdout)?.[1]?.toLowerCase()
    return resolved ? localAddresses().has(resolved) : false
  }
}

/** Addresses that name this machine. */
function localAddresses(): Set<string> {
  const out = new Set(['localhost', '127.0.0.1', '::1', hostname().toLowerCase(), `${hostname().toLowerCase()}.local`])
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) out.add(entry.address.toLowerCase())
  return out
}

/** Whether nothing listens on `port` on this machine's loopback. */
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** Whether ssh failed because the host refused the key, the password, or the passphrase. */
export function isSshAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(normalized) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  )
}

/** cmd.exe's and PowerShell's answer to `sh`: the host runs Windows. */
export function isMissingPosixShell(output: string): boolean {
  return /is not recognized as (?:an internal or external command|the name of a cmdlet)/i.test(output)
}

/** A PowerShell single-quoted literal: only `'` is special in it, and doubling escapes it. */
export function powerShellLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "''")}'`
}

/**
 * The remote command that runs `script` on a Windows host. Its SSH shell is
 * cmd.exe or PowerShell, and both run this line the same way. The script goes
 * as base64 UTF-16LE (`-EncodedCommand`), so neither shell parses it.
 */
export function powerShellCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded].join(' ')
}
