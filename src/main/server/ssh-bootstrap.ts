import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { homedir, userInfo } from 'os'
import { join } from 'path'
import { text } from 'node:stream/consumers'
import { z } from 'zod'
import type { DiscoveredServer, SshBootstrapResult, SshTargetCandidate } from '../../shared/types'
import { sshConnectionOptions } from './handlers/lib/ssh-options'
import { writeTempSecretScript } from './handlers/lib/temp-secret-script'

const MAX_AUTH_PROMPTS = 2

const sshBootstrapCredentialSchema = z
  .object({
    sessionToken: z.string(),
    installationId: z.string(),
    fingerprint: z.string(),
    ownerDeviceId: z.string().optional(),
    claimedAt: z.number().optional(),
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

const REMOTE_CREDENTIAL_SCRIPT = `set -eu
DEVICE_LABEL="$1"
if command -v solus >/dev/null 2>&1; then
  exec solus auth session create --json --device-label "$DEVICE_LABEL"
fi
if command -v solus-server >/dev/null 2>&1; then
  exec solus-server auth session create --json --device-label "$DEVICE_LABEL"
fi
printf 'Solus CLI not found on PATH. Install the Solus server package or add solus/solus-server to PATH.\\n' >&2
exit 127
`

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
  }
  if (hasSecret) runOptions.authSecret = input.authSecret
  const result = await runSsh(runOptions)

  if (result.code !== 0) {
    if (isSshAuthFailure(`${result.stderr}\n${result.stdout}`) && attempt < MAX_AUTH_PROMPTS) {
      return {
        status: 'needs-auth',
        sshTarget: formatSshTarget(resolved.target),
        attempt: attempt + 1,
        message: `SSH authentication failed for ${formatSshTarget(resolved.target)}.`,
      }
    }
    throw new Error(commandFailureMessage(result))
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
    args.push(options.target.destination, 'sh', '-s', '--', options.deviceLabel)
    const env = { ...process.env }
    if (askpass) {
      Object.assign(env, {
        SSH_ASKPASS: askpass.path,
        SSH_ASKPASS_REQUIRE: 'force',
        SOLUS_SSH_AUTH_SECRET: options.authSecret ?? '',
      })
      if (!process.env.DISPLAY) env.DISPLAY = 'solus'
    }
    const child = spawn('ssh', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(REMOTE_CREDENTIAL_SCRIPT)
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
  return writeTempSecretScript('solus-ssh-askpass-', 'ssh-askpass.sh', ASKPASS_SCRIPT)
}

function lastNonEmptyLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1)
  return line ?? null
}

function commandFailureMessage(result: SshRunResult): string {
  return lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? `SSH bootstrap failed (${result.code}).`
}

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
