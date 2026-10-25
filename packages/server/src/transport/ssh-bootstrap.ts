import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir, userInfo } from 'os'
import { join } from 'path'
import { text } from 'node:stream/consumers'
import { z } from 'zod'
import type { DiscoveredServer, SshBootstrapResult, SshTargetCandidate } from '@solus/contracts/types'
import { sshConnectionOptions } from './handlers/lib/ssh-options'
import { writeTempSecretScript } from './handlers/lib/temp-secret-script'

const MAX_AUTH_PROMPTS = 2

const sshBootstrapCredentialSchema = z
  .object({
    sessionToken: z.string(),
    installationId: z.string(),
    fingerprint: z.string(),
  })
  .strict()

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

export const SSH_BOOTSTRAP_CREDENTIAL_SCRIPT = `set -eu
DEVICE_LABEL="$1"
CLI_PATH=""
if command -v solus >/dev/null 2>&1; then
  CLI_PATH="$(command -v solus)"
elif command -v solus-server >/dev/null 2>&1; then
  CLI_PATH="$(command -v solus-server)"
elif [ -n "\${SHELL:-}" ] && [ -x "$SHELL" ]; then
  # sshd's non-interactive PATH omits shell-managed tools such as Linuxbrew
  # and nvm. Ask the remote account's own login shell for the executable it
  # would use, then invoke that absolute path without evaluating shell output.
  CLI_PATH="$("$SHELL" -ilc 'command -v solus || command -v solus-server' 2>/dev/null | tail -n 1)"
fi
if [ -n "$CLI_PATH" ] && [ -x "$CLI_PATH" ]; then
  exec "$CLI_PATH" auth session create --json --device-label "$DEVICE_LABEL"
fi
printf 'Solus CLI not found in the SSH or login-shell PATH. Install the Solus server package or add solus/solus-server to PATH.\\n' >&2
exit 127
`

/** What the Windows bootstrap prints and exits with when the host has no `solus` command. */
const WINDOWS_CLI_MISSING_CODE = 127
const WINDOWS_CLI_MISSING = 'Solus is not installed on this Windows host. Install the Solus server on this Windows host first, or pair with a code.'

/** A PowerShell single-quoted literal: only `'` is special in it, and doubling escapes it. */
function powerShellLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "''")}'`
}

/**
 * The bootstrap for a Windows host, as PowerShell. `solus.cmd` runs through
 * cmd.exe, which parses `"`, `%`, `!`, `^`, `&`, `|`, `<`, and `>` in its
 * arguments, so the label loses those characters before it reaches the command.
 */
export function windowsCredentialScript(deviceLabel: string): string {
  const label = deviceLabel.replace(/["%!^&|<>\r\n]/g, '').trim() || 'Solus desktop'
  return [
    `$label = ${powerShellLiteral(label)}`,
    '$cli = Get-Command solus -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source',
    "if (-not $cli) { $fallback = Join-Path $env:USERPROFILE '.local\\bin\\solus.cmd'; if (Test-Path -LiteralPath $fallback) { $cli = $fallback } }",
    `if (-not $cli) { [Console]::Error.WriteLine(${powerShellLiteral(WINDOWS_CLI_MISSING)}); exit ${WINDOWS_CLI_MISSING_CODE} }`,
    '& $cli auth session create --json --device-label $label',
    'exit $LASTEXITCODE',
  ].join('\n')
}

/**
 * The remote command for a Windows host. Its SSH shell is cmd.exe or
 * PowerShell, and both run this line the same way. The script goes as
 * base64 UTF-16LE (`-EncodedCommand`), so neither shell parses the label.
 */
export function windowsCredentialCommand(deviceLabel: string): string[] {
  const encoded = Buffer.from(windowsCredentialScript(deviceLabel), 'utf16le').toString('base64')
  return ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

export interface BootstrapDiscoveredServerInput {
  server: DiscoveredServer
  sshTarget?: string
  authSecret?: string
  attempt?: number
  deviceLabel?: string
}

export interface SshRunOptions {
  target: ParsedSshTarget
  batchMode: boolean
  authSecret?: string
  deviceLabel: string
  /** The remote host's shell: `sh` everywhere but Windows. */
  shell: 'sh' | 'powershell'
}

export interface SshRunResult {
  stdout: string
  stderr: string
  code: number
}

export async function bootstrapDiscoveredServerOverSsh(
  input: BootstrapDiscoveredServerInput,
  runSsh: (options: SshRunOptions) => Promise<SshRunResult> = runSshCredentialCommand,
): Promise<SshBootstrapResult> {
  const resolved = resolveSshBootstrapTarget(input.server, input.sshTarget)
  if (resolved.status === 'needs-target') return resolved

  const attempt = Math.max(0, input.attempt ?? 0)
  const hasSecret = !!input.authSecret
  const runOptions: SshRunOptions = {
    target: resolved.target,
    batchMode: !hasSecret,
    deviceLabel: (input.deviceLabel ?? 'Solus desktop').slice(0, 64),
    shell: 'sh',
  }
  if (hasSecret) runOptions.authSecret = input.authSecret
  let result = await runSsh(runOptions)
  // A Windows host has no `sh`. Its answer tells the bootstrap to ask PowerShell.
  // cmd.exe can report it and still exit 0, so the exit code does not decide.
  if (WINDOWS_SHELL_MISS.test(result.stderr)) {
    runOptions.shell = 'powershell'
    result = await runSsh(runOptions)
  }

  if (result.code !== 0) {
    if (isSshAuthFailure(`${result.stderr}\n${result.stdout}`) && attempt < MAX_AUTH_PROMPTS) {
      return {
        status: 'needs-auth',
        sshTarget: formatSshTarget(resolved.target),
        attempt: attempt + 1,
        message: `SSH authentication failed for ${formatSshTarget(resolved.target)}.`,
      }
    }
    throw new Error(commandFailureMessage(result, runOptions.shell))
  }

  const line = lastNonEmptyLine(result.stdout)
  if (!line) throw new Error('SSH bootstrap did not return a credential.')
  let parsedCredential
  try {
    parsedCredential = sshBootstrapCredentialSchema.safeParse(JSON.parse(line))
  } catch {
    throw new Error('SSH bootstrap returned an incomplete credential.')
  }
  if (!parsedCredential.success) {
    throw new Error('SSH bootstrap returned an incomplete credential.')
  }
  return { status: 'connected', credential: parsedCredential.data }
}

export type ResolveSshBootstrapTargetResult =
  | { status: 'ready'; target: ParsedSshTarget }
  | { status: 'needs-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }

export function resolveSshBootstrapTarget(
  server: DiscoveredServer,
  explicitTarget?: string,
): ResolveSshBootstrapTargetResult {
  if (explicitTarget?.trim()) return { status: 'ready', target: parseSshTarget(explicitTarget) }

  const candidates = sshTargetCandidates(server)
  const configCandidates = candidates.filter((candidate) => candidate.source === 'ssh-config')
  if (configCandidates.length === 1) {
    return { status: 'ready', target: parseSshTarget(configCandidates[0].target) }
  }

  const defaultTarget = `${safeLocalUsername()}@${server.name || server.host}`
  return {
    status: 'needs-target',
    candidates,
    defaultTarget,
    message: `Enter the SSH target for ${server.name || server.host}.`,
  }
}

export interface ParsedSshTarget {
  destination: string
  port?: number
}

export function parseSshTarget(input: string): ParsedSshTarget {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('SSH target is required.')
  const bracketMatch = trimmed.match(/^(.+@\[[^\]]+\]|\[[^\]]+\])(?::(\d+))?$/)
  if (bracketMatch) {
    const target: ParsedSshTarget = { destination: bracketMatch[1] }
    if (bracketMatch[2]) target.port = parseSshPort(bracketMatch[2])
    return target
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > -1 && trimmed.indexOf(':') === colon) {
    const maybePort = trimmed.slice(colon + 1)
    if (/^\d+$/.test(maybePort)) {
      return { destination: trimmed.slice(0, colon), port: parseSshPort(maybePort) }
    }
  }
  return { destination: trimmed }
}

export function formatSshTarget(target: ParsedSshTarget): string {
  return target.port ? `${target.destination}:${target.port}` : target.destination
}

export function isSshAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(normalized) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  )
}

export async function runSshCredentialCommand(options: SshRunOptions): Promise<SshRunResult> {
  const askpass = options.authSecret ? await createAskpassHelper() : null
  try {
    const args = [...sshConnectionOptions(options.batchMode), '-o', 'NumberOfPasswordPrompts=1']
    if (options.target.port) args.push('-p', String(options.target.port))
    if (options.shell === 'powershell') args.push(options.target.destination, ...windowsCredentialCommand(options.deviceLabel))
    else args.push(options.target.destination, 'sh', '-s', '--', options.deviceLabel)
    const env = { ...process.env }
    if (askpass) Object.assign(env, askpassEnv(process.platform, askpass.path, options.authSecret ?? '', process.env))
    const child = spawn('ssh', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdin.end(options.shell === 'powershell' ? '' : SSH_BOOTSTRAP_CREDENTIAL_SCRIPT)
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once('exit', (code) => resolve(code ?? 1))
      child.once('error', reject)
    })
    const [stdout, stderr, code] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      exitCode,
    ])
    return { stdout, stderr, code }
  } finally {
    if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
  }
}

export function sshTargetCandidates(server: DiscoveredServer): SshTargetCandidate[] {
  const candidates = new Map<string, SshTargetCandidate>()
  for (const entry of readSshConfigEntries()) {
    if (!sshConfigEntryMatches(entry, server)) continue
    const alias = entry.hosts.find((host) => !hasSshPattern(host)) ?? entry.hosts[0]
    const destination = entry.user ? `${entry.user}@${alias}` : alias
    const target = entry.port ? `${destination}:${entry.port}` : destination
    candidates.set(target, {
      target,
      label: entry.hostname ? `${alias} -> ${entry.hostname}` : alias,
      source: 'ssh-config',
    })
  }
  for (const host of readKnownHosts()) {
    if (host !== server.host && host !== server.name) continue
    const target = `${safeLocalUsername()}@${host}`
    if (!candidates.has(target)) {
      candidates.set(target, { target, label: host, source: 'known-hosts' })
    }
  }
  return [...candidates.values()]
}

interface SshConfigEntry {
  hosts: string[]
  hostname?: string
  user?: string
  port?: number
}

function readSshConfigEntries(): SshConfigEntry[] {
  const file = join(homedir(), '.ssh', 'config')
  if (!existsSync(file)) return []
  const entries: SshConfigEntry[] = []
  let current: SshConfigEntry | null = null
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const [keywordRaw, ...rest] = line.split(/\s+/)
    const keyword = keywordRaw.toLowerCase()
    const value = rest.join(' ')
    if (keyword === 'host') {
      current = { hosts: rest.filter((host) => !host.startsWith('!')) }
      entries.push(current)
      continue
    }
    if (!current) continue
    if (keyword === 'hostname' && value) current.hostname = value
    else if (keyword === 'user' && value) current.user = value
    else if (keyword === 'port' && /^\d+$/.test(value)) current.port = parseSshPort(value)
  }
  return entries
}

function sshConfigEntryMatches(entry: SshConfigEntry, server: DiscoveredServer): boolean {
  const names = new Set([server.host, server.name, `${server.name}.local`].filter(Boolean))
  if (entry.hostname && names.has(entry.hostname)) return true
  return entry.hosts.some((host) => !hasSshPattern(host) && names.has(host))
}

function readKnownHosts(): string[] {
  const file = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(file)) return []
  const hosts = new Set<string>()
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('|')) continue
    const first = rawLine.split(/\s+/)[0]
    for (const host of first.split(',')) {
      if (!host || host.startsWith('[')) continue
      hosts.add(host)
    }
  }
  return [...hosts]
}

async function createAskpassHelper(): Promise<{ directory: string; path: string }> {
  const helper = askpassHelper(process.platform)
  if (process.platform !== 'win32') return writeTempSecretScript('solus-ssh-askpass-', helper.name, helper.content)
  // Windows has no execute bit: the `.cmd` extension makes the helper runnable.
  const directory = await mkdtemp(join(tmpdir(), 'solus-ssh-askpass-'))
  const path = join(directory, helper.name)
  await writeFile(path, helper.content)
  return { directory, path }
}

function lastNonEmptyLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1)
  return line ?? null
}

function commandFailureMessage(result: SshRunResult, shell: SshRunOptions['shell']): string {
  if (shell === 'powershell') {
    if (result.code === WINDOWS_CLI_MISSING_CODE) return WINDOWS_CLI_MISSING
    // cmd.exe's last line alone ("operable program or batch file.") does not say why it failed.
    if (WINDOWS_SHELL_MISS.test(`${result.stderr}\n${result.stdout}`)) {
      return 'This host runs Windows, and Solus could not start PowerShell there over SSH. Pair with a code instead.'
    }
  }
  return lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? `SSH bootstrap failed (${result.code}).`
}

/** cmd.exe's and PowerShell's answer to `sh`, which Windows does not have. */
const WINDOWS_SHELL_MISS = /is not recognized as (?:an internal or external command|the name of a cmdlet)/i

function parseSshPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid SSH port: ${value}`)
  return port
}

function hasSshPattern(value: string): boolean {
  return /[*?]/.test(value)
}

function safeLocalUsername(): string {
  try {
    return userInfo().username || 'user'
  } catch {
    return 'user'
  }
}
