import { z } from 'zod'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import { INSTALL_SCRIPT_URLS, type SshAddLink, type SshAddStep } from '@solus/contracts/remote-machines'
import type { HostOperatingSystem } from '@solus/contracts/types'
import { formatLinkCode } from '@solus/contracts/uplink'
import type { DeviceCommandResult } from '../devices/device-process'
import { createLogger } from '../logger'
import { isMissingPosixShell, isSshAuthFailure, powerShellCommand, powerShellLiteral, quoteRemoteArg, type SshRunOptions, type SshTarget } from '../platform/ssh'
import type { MachineClient } from './wsl'
import { formatSshTarget } from './ssh-targets'

const log = createLogger('main', 'ssh-provisioner')

/**
 * Adds a machine that this host reaches with SSH (docs/plans/host-routes.md D6).
 * It checks the machine, installs Solus there with the published installer when it
 * is not there, starts it as a service with `solus setup`, and then either links it
 * to the account (`--link CODE`) or makes a session for this host's forward. A server
 * that already runs there is used as it is, and Solus does not take it over.
 *
 * The installer and `solus setup` own the install and the service on every system:
 * a `systemd --user` service on Linux, a `launchd` agent on macOS, and a logon task
 * on Windows. This class only drives them over SSH.
 */

/** Where Solus lives on the machine; empty means the installer's defaults. A test uses a place of its own beside a live install. */
export interface RemoteInstallPlace {
  dataDir?: string
  port?: number
  runtimeDir?: string
  binDir?: string
  /** The release to install; empty means the latest. A WSL distro gets this host's own version. */
  version?: string
}

const installPlaceSchema = z.object({
  dataDir: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  runtimeDir: z.string().min(1).optional(),
  binDir: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
})

/**
 * The place `SOLUS_SSH_INSTALL_PLACE` names, as JSON. It lets a test (or a second
 * instance) install Solus beside one that already runs on the machine; empty in
 * normal use. An unreadable value is refused at boot, not ignored.
 */
export function installPlaceFromEnv(value: string | undefined): RemoteInstallPlace {
  if (!value) return {}
  return installPlaceSchema.parse(JSON.parse(value))
}

export interface ProvisionRequest {
  target: SshTarget
  authSecret?: string
  link?: SshAddLink
  deviceLabel: string
  /** What the person calls the machine; its own host name when omitted. A WSL distro reports the computer's name. */
  label?: string
}

/** A machine Solus runs on after an add. */
export interface ProvisionedHost {
  target: SshTarget
  os: HostOperatingSystem
  label: string
  installationId: string
  /** The loopback port the server listens on there. */
  remotePort: number
  /** Solus installed or started the service, so removing the host stops it. */
  startedBySolus: boolean
  /** Present when the add made a session for this host's forward (no account). */
  session?: { sessionToken: string; identityKey: string }
}

export type ProvisionOutcome =
  | { status: 'needs-auth'; message: string }
  | { status: 'ready'; host: ProvisionedHost }

/** What the check reads on the machine. */
interface RemoteMachine {
  shell: 'sh' | 'powershell'
  os: HostOperatingSystem
  name: string
  /** The `solus` command there; empty when Solus is not installed. */
  cli: string
  /** The port of a server that runs now; null when none runs. */
  port: number | null
  installationId: string
}

/** A download and an install can take minutes on a slow link. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
const STEP_TIMEOUT_MS = 2 * 60_000

class AuthNeeded extends Error {}

export class SshProvisioner {
  constructor(
    /** Runs the steps over SSH, or in a WSL distro of this host. */
    private readonly ssh: Pick<MachineClient, 'run'>,
    private readonly place: RemoteInstallPlace = {},
  ) {}

  async add(request: ProvisionRequest, progress: (step: SshAddStep, message: string) => void): Promise<ProvisionOutcome> {
    const name = formatSshTarget(request.target)
    try {
      progress('connect', `Connecting to ${name}`)
      let machine = await this.check(request)
      progress('check', machine.cli ? `Solus is installed on ${machine.name}` : `Solus is not installed on ${machine.name}`)
      const code = request.link ? formatLinkCode(request.link.ticket, request.link.directoryUrl) : null
      let startedBySolus = false
      if (!machine.cli) {
        progress('install', `Installing Solus on ${machine.name}`)
        await this.runStep(request, machine, 'install', code ? ['--link', code] : ['--setup'], INSTALL_TIMEOUT_MS)
        startedBySolus = true
      } else if (machine.port === null) {
        progress('start', `Starting Solus on ${machine.name}`)
        await this.runStep(request, machine, 'setup', code ? ['--link', code] : [], STEP_TIMEOUT_MS)
        startedBySolus = true
      } else if (code) {
        progress('link', `Linking ${machine.name} to your account`)
        await this.runStep(request, machine, 'connect', ['--code', code], STEP_TIMEOUT_MS)
      }
      if (startedBySolus) machine = await this.check(request)
      if (!machine.cli || machine.port === null) throw new Error(`Solus did not start on ${machine.name}. Run \`solus status\` there.`)
      const host: ProvisionedHost = {
        target: request.target,
        os: machine.os,
        label: machine.name,
        installationId: machine.installationId,
        remotePort: machine.port,
        startedBySolus,
      }
      if (!request.link) {
        progress('identity', `Reading the identity of ${machine.name}`)
        const { installationId, ...session } = await this.createSession(request, machine)
        host.session = session
        host.installationId = installationId
      }
      log.info('ssh_host_provisioned', { os: host.os, startedBySolus, linked: !!request.link })
      return { status: 'ready', host }
    } catch (error) {
      if (error instanceof AuthNeeded) return { status: 'needs-auth', message: error.message }
      throw error
    }
  }

  /** Stops and removes the service Solus installed there. The install and its data stay. */
  async uninstallService(target: SshTarget, os: HostOperatingSystem): Promise<void> {
    const request: ProvisionRequest = { target, deviceLabel: '' }
    const machine = await this.check(request)
    if (!machine.cli) return
    await this.runStep(request, { ...machine, os }, 'service-uninstall', [], STEP_TIMEOUT_MS)
  }

  /** Reads the machine. On a host with no `sh` (Windows), PowerShell reads it. */
  async check(request: Pick<ProvisionRequest, 'target' | 'authSecret' | 'label'>): Promise<RemoteMachine> {
    let shell: RemoteMachine['shell'] = 'sh'
    let result = await this.run(request, shell, unixScript('check', this.place), [], STEP_TIMEOUT_MS)
    if (isMissingPosixShell(`${result.stderr}\n${result.stdout}`)) {
      shell = 'powershell'
      result = await this.run(request, shell, windowsScript('check', this.place, []), [], STEP_TIMEOUT_MS)
    }
    failUnless(result, `Solus could not read ${formatSshTarget(request.target)}.`)
    const machine = parseCheck(result.stdout, shell)
    return request.label ? { ...machine, name: request.label } : machine
  }

  /** The port the server listens on now; null when it is not running. */
  async remotePort(target: SshTarget): Promise<number | null> {
    return (await this.check({ target })).port
  }

  private async createSession(request: ProvisionRequest, machine: RemoteMachine): Promise<{ sessionToken: string; identityKey: string; installationId: string }> {
    const result = await this.runStep(request, machine, 'session', [request.deviceLabel], STEP_TIMEOUT_MS)
    const line = result.stdout.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? ''
    const session = parseSession(line)
    if (!session) throw new Error(`${machine.name} runs a Solus version that cannot prove its identity. Update Solus there with \`solus update\`, then add it again.`)
    return session
  }

  private async runStep(request: ProvisionRequest, machine: RemoteMachine, step: RemoteStep, args: string[], timeoutMs: number): Promise<DeviceCommandResult> {
    const result = machine.shell === 'sh'
      ? await this.run(request, 'sh', unixScript(step, this.place), [machine.cli, ...args], timeoutMs)
      : await this.run(request, 'powershell', windowsScript(step, this.place, [machine.cli, ...args]), [], timeoutMs)
    if (step === 'install' && machine.os === 'windows' && /\(404\)/.test(result.stderr)) {
      throw new Error(`The latest Solus release has no Windows installer. Install Solus on ${machine.name} by hand, then add it again.`)
    }
    failUnless(result, `Solus could not ${STEP_VERBS[step]} on ${machine.name}.`)
    return result
  }

  private async run(request: Pick<ProvisionRequest, 'target' | 'authSecret'>, shell: RemoteMachine['shell'], script: string, args: string[], timeoutMs: number): Promise<DeviceCommandResult> {
    const options: SshRunOptions = { acceptNewHostKey: true, timeoutMs }
    if (request.authSecret) options.authSecret = request.authSecret
    const result = shell === 'sh'
      ? await this.ssh.run(request.target, script, args, { ...options, command: unixCommand(this.place) })
      : await this.ssh.run(request.target, undefined, [], { ...options, command: powerShellCommand(script) })
    if (result.code !== 0 && isSshAuthFailure(`${result.stderr}\n${result.stdout}`)) {
      throw new AuthNeeded(`SSH refused the key for ${formatSshTarget(request.target)}.`)
    }
    return result
  }
}

type RemoteStep = 'check' | 'install' | 'setup' | 'connect' | 'session' | 'service-uninstall'

const STEP_VERBS = {
  check: 'read the machine',
  install: 'install Solus',
  setup: 'start Solus',
  connect: 'link Solus to your account',
  session: 'make a session',
  'service-uninstall': 'remove the Solus service',
} satisfies Record<RemoteStep, string>

const sessionSchema = z.object({
  sessionToken: z.string().min(1),
  installationId: z.string().min(1),
  identityKey: hostIdentityKeySchema,
})

/** The session `auth session create --json` printed; null when the line is not one. */
function parseSession(line: string): z.infer<typeof sessionSchema> | null {
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function failUnless(result: DeviceCommandResult, message: string): void {
  if (result.code === 0) return
  const detail = [result.stderr, result.stdout].map((text) => text.trim().split(/\r?\n/).at(-1) ?? '').find(Boolean)
  throw new Error(detail ? `${message} ${detail}` : message)
}

function parseCheck(stdout: string, shell: RemoteMachine['shell']): RemoteMachine {
  const fields = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const system = fields.get('os') ?? ''
  const os: HostOperatingSystem = /darwin/i.test(system) ? 'macos' : /windows/i.test(system) ? 'windows' : 'linux'
  const port = Number(fields.get('port'))
  return {
    shell,
    os,
    name: fields.get('name') || 'the machine',
    cli: fields.get('cli') ?? '',
    port: Number.isInteger(port) && port > 0 ? port : null,
    installationId: fields.get('installation') ?? '',
  }
}

/** The installer's and the CLI's place variables, so a test install never touches the live one. */
function placeVariables(place: RemoteInstallPlace): Array<[string, string]> {
  const variables: Array<[string, string]> = []
  if (place.dataDir) variables.push(['SOLUS_DATA_DIR', place.dataDir])
  if (place.port) variables.push(['SOLUS_PORT', String(place.port)])
  if (place.runtimeDir) variables.push(['SOLUS_RUNTIME_DIR', place.runtimeDir])
  if (place.binDir) variables.push(['SOLUS_BIN_DIR', place.binDir])
  if (place.version) variables.push(['SOLUS_VERSION', place.version])
  return variables
}

function unixCommand(place: RemoteInstallPlace): string {
  const variables = placeVariables(place).map(([name, value]) => `${name}=${quoteRemoteArg(value)}`)
  return [...(variables.length ? ['env', ...variables] : []), 'sh', '-s', '--'].join(' ')
}

/** The POSIX script of one step. The CLI path is `$1`; the step's own arguments follow. */
function unixScript(step: RemoteStep, place: RemoteInstallPlace): string {
  const findCli = place.binDir
    // A test names its own bin folder: only a `solus` there counts, never the live one on PATH.
    ? 'cli=""; [ -x "$bin_dir/solus" ] && cli="$bin_dir/solus"'
    : [
      'cli=""',
      'if [ -x "$bin_dir/solus" ]; then cli="$bin_dir/solus"',
      'elif command -v solus >/dev/null 2>&1; then cli="$(command -v solus)"',
      // sshd's PATH leaves out shell-managed folders: ask the account's login shell.
      'elif [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then cli="$("$SHELL" -ilc \'command -v solus\' 2>/dev/null | tail -n 1)"; fi',
      '[ -n "$cli" ] && [ -x "$cli" ] || cli=""',
    ].join('\n')
  switch (step) {
    case 'check': return [
      'set -u',
      'bin_dir="${SOLUS_BIN_DIR:-$HOME/.local/bin}"',
      'data_dir="${SOLUS_DATA_DIR:-$HOME/.solus}"',
      findCli,
      'port=""',
      'if [ -f "$data_dir/server.lock" ]; then',
      '  pid="$(sed -n \'s/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p\' "$data_dir/server.lock" | head -n 1)"',
      '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then port="$(sed -n \'s/.*"port": *\\([0-9][0-9]*\\).*/\\1/p\' "$data_dir/server.lock" | head -n 1)"; fi',
      'fi',
      'installation=""',
      '[ -f "$data_dir/server-keys.json" ] && installation="$(sed -n \'s/.*"installationId": *"\\([^"]*\\)".*/\\1/p\' "$data_dir/server-keys.json" | head -n 1)"',
      'printf \'os=%s\\nname=%s\\ncli=%s\\nport=%s\\ninstallation=%s\\n\' "$(uname -s)" "$(uname -n)" "$cli" "$port" "$installation"',
    ].join('\n')
    case 'install': return [
      'set -eu',
      'shift',
      `url=${quoteRemoteArg(INSTALL_SCRIPT_URLS.unix)}`,
      'if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" | sh -s -- "$@"',
      'elif command -v wget >/dev/null 2>&1; then wget -qO- "$url" | sh -s -- "$@"',
      'else echo "Install curl or wget on this machine." >&2; exit 1; fi',
    ].join('\n')
    case 'setup': return 'set -eu\ncli="$1"; shift\nexec "$cli" setup "$@"'
    case 'connect': return 'set -eu\ncli="$1"; shift\nexec "$cli" connect --no-open "$@"'
    case 'session': return 'set -eu\nexec "$1" auth session create --json --device-label "$2"'
    case 'service-uninstall': return 'set -eu\nexec "$1" service uninstall'
  }
}

/** The PowerShell script of one step on a Windows host; `args` are the CLI path and the step's arguments. */
function windowsScript(step: RemoteStep, place: RemoteInstallPlace, args: string[]): string {
  const variables = placeVariables(place).map(([name, value]) => `$env:${name} = ${powerShellLiteral(value)}`)
  const [cli = '', ...rest] = args
  const call = (verb: string) => `& ${powerShellLiteral(cli)} ${verb} ${rest.map(powerShellLiteral).join(' ')}\nexit $LASTEXITCODE`
  const body = (() => {
    switch (step) {
      case 'check': return [
        "$bin = if ($env:SOLUS_BIN_DIR) { $env:SOLUS_BIN_DIR } else { Join-Path $env:USERPROFILE '.local\\bin' }",
        "$data = if ($env:SOLUS_DATA_DIR) { $env:SOLUS_DATA_DIR } else { Join-Path $env:USERPROFILE '.solus' }",
        "$cli = Join-Path $bin 'solus.cmd'",
        'if (-not (Test-Path -LiteralPath $cli)) {',
        "  $cli = ''",
        '  if (-not $env:SOLUS_BIN_DIR) { $found = Get-Command solus -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source; if ($found) { $cli = $found } }',
        '}',
        "$port = ''",
        "$lock = Join-Path $data 'server.lock'",
        'if (Test-Path -LiteralPath $lock) { try { $held = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json; if (Get-Process -Id $held.pid -ErrorAction SilentlyContinue) { $port = [string]$held.port } } catch {} }',
        "$installation = ''",
        "$keys = Join-Path $data 'server-keys.json'",
        'if (Test-Path -LiteralPath $keys) { try { $installation = (Get-Content -LiteralPath $keys -Raw | ConvertFrom-Json).installationId } catch {} }',
        '"os=Windows"',
        '"name=$env:COMPUTERNAME"',
        '"cli=$cli"',
        '"port=$port"',
        '"installation=$installation"',
      ].join('\n')
      case 'install': {
        const flags = rest[0] === '--link' ? `-Link ${powerShellLiteral(rest[1] ?? '')}` : '-Setup'
        return `$ProgressPreference = 'SilentlyContinue'\n& ([scriptblock]::Create((Invoke-RestMethod ${powerShellLiteral(INSTALL_SCRIPT_URLS.windows)}))) ${flags}\nexit $LASTEXITCODE`
      }
      case 'setup': return call('setup')
      case 'connect': return call('connect --no-open')
      case 'session': return call('auth session create --json --device-label')
      case 'service-uninstall': return call('service uninstall')
    }
  })()
  return [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5.1 does not offer TLS 1.2 unless asked, and GitHub needs it.
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    ...variables,
    // An error leaves as one plain line: over SSH, PowerShell would write it as CLIXML.
    `try {\n${body}\n} catch {\n  [Console]::Error.WriteLine($_.Exception.Message)\n  exit 1\n}`,
  ].join('\n')
}
