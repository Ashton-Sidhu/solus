/**
 * The per-user native service (`solus setup`, `solus service ...`). Linux
 * uses a systemd user unit; macOS uses a LaunchAgent. Both point at the
 * stable launcher (`~/.local/bin/solus start`), never a version-specific
 * path, so an update never needs to touch the unit definition.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ServiceExec = (command: string, args: string[]) => string

export function defaultServiceExec(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000 })
}

const LINUX_UNIT_NAME = 'solus.service'
const MACOS_LABEL = 'sh.solus.server'

export function linuxUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', LINUX_UNIT_NAME)
}

function unitQuote(value: string): string {
  return JSON.stringify(value).replaceAll('%', '%%').replaceAll('$', '$$')
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function linuxUnitContent(binDir: string, env?: ServiceEnv): string {
  return `[Unit]
Description=Solus server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${unitQuote(join(binDir, 'solus'))} start${env?.dataDir ? ` --data-dir ${unitQuote(env.dataDir)}` : ''}
${env?.runtimeDir ? `Environment=${unitQuote(`SOLUS_RUNTIME_DIR=${env.runtimeDir}`)}` : ''}
${env?.host ? `Environment=${unitQuote(`SOLUS_HOST=${env.host}`)}` : ''}
${env?.port ? `Environment=${unitQuote(`SOLUS_PORT=${env.port}`)}` : ''}
KillMode=mixed
TimeoutStopSec=90
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`
}

export function macosPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`)
}

export function macosPlistLabel(): string {
  return MACOS_LABEL
}

export function macosPlistContent(binDir: string, logFile: string, env?: ServiceEnv): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(join(binDir, 'solus'))}</string>
    <string>start</string>
    ${env?.dataDir ? `<string>--data-dir</string><string>${xml(env.dataDir)}</string>` : ''}
  </array>
  <key>EnvironmentVariables</key><dict>
    ${env?.runtimeDir ? `<key>SOLUS_RUNTIME_DIR</key><string>${xml(env.runtimeDir)}</string>` : ''}
    ${env?.host ? `<key>SOLUS_HOST</key><string>${xml(env.host)}</string>` : ''}
    ${env?.port ? `<key>SOLUS_PORT</key><string>${xml(env.port)}</string>` : ''}
  </dict>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>AbandonProcessGroup</key><false/>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`
}

export interface ServiceStatus {
  platform: 'linux' | 'darwin'
  installed: boolean
  active: boolean
  enabled: boolean
  detail: string | null
}

export interface ServiceEnv {
  dataDir?: string
  runtimeDir?: string
  host?: string
  port?: string
  home: string
  binDir: string
  logFile: string
  platform: NodeJS.Platform
  exec: ServiceExec
}

function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is 'linux' | 'darwin' {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`solus service is not supported on ${platform}. Run \`solus start\` in the foreground instead.`)
  }
}

export interface ServiceInstallResult {
  lingerAdvice: string | null
}

/** Writes the unit/plist and starts it now. Reports whether Linux lingering
 *  (surviving logout) is already on, and how to turn it on if this account
 *  cannot enable it for itself. */
export function installService(env: ServiceEnv): ServiceInstallResult {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') return installLinuxService(env)
  installMacService(env)
  return { lingerAdvice: null }
}

function installLinuxService(env: ServiceEnv): ServiceInstallResult {
  env.exec('systemctl', ['--user', 'show-environment'])
  const lingerAdvice = ensureLinger(env)
  const unitPath = linuxUnitPath(env.home)
  mkdirSync(join(unitPath, '..'), { recursive: true })
  writeFileSync(unitPath, linuxUnitContent(env.binDir, env))
  env.exec('systemctl', ['--user', 'daemon-reload'])
  env.exec('systemctl', ['--user', 'enable', '--now', LINUX_UNIT_NAME])
  return { lingerAdvice }
}

/** Without lingering, systemd stops every user unit at logout. Enabling it
 *  for oneself needs a privilege most accounts do not have by default. */
function ensureLinger(env: ServiceEnv): string | null {
  const user = process.env.USER || process.env.LOGNAME
  if (!user) return null
  try {
    const shown = env.exec('loginctl', ['show-user', user, '-p', 'Linger'])
    if (shown.includes('Linger=yes')) return null
  } catch {
    return `Could not check lingering for ${user}. Run: sudo loginctl enable-linger ${user}`
  }
  try {
    env.exec('loginctl', ['enable-linger', user])
    return null
  } catch {
    return `Solus will stop when you log out unless lingering is on. Run: sudo loginctl enable-linger ${user}`
  }
}

function installMacService(env: ServiceEnv): void {
  const plistPath = macosPlistPath(env.home)
  mkdirSync(join(plistPath, '..'), { recursive: true })
  mkdirSync(dirname(env.logFile), { recursive: true })
  writeFileSync(plistPath, macosPlistContent(env.binDir, env.logFile, env))
  const uid = env.exec('id', ['-u']).trim()
  try { env.exec('launchctl', ['bootout', `gui/${uid}/${MACOS_LABEL}`]) } catch { /* not loaded yet */ }
  env.exec('launchctl', ['enable', `gui/${uid}/${MACOS_LABEL}`])
  env.exec('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
}

export function serviceStatus(env: ServiceEnv): ServiceStatus {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') {
    const installed = existsSync(linuxUnitPath(env.home))
    if (!installed) return { platform: 'linux', installed: false, active: false, enabled: false, detail: null }
    const active = tryExec(env, 'systemctl', ['--user', 'is-active', LINUX_UNIT_NAME]).trim() === 'active'
    const enabled = tryExec(env, 'systemctl', ['--user', 'is-enabled', LINUX_UNIT_NAME]).trim() === 'enabled'
    const linger = tryExec(env, 'loginctl', ['show-user', process.env.USER || '', '-p', 'Linger'])
    const detail = linger.includes('Linger=yes') ? null : 'Lingering is off: Solus stops at logout unless a login session stays open.'
    return { platform: 'linux', installed, active, enabled, detail }
  }
  const installed = existsSync(macosPlistPath(env.home))
  if (!installed) return { platform: 'darwin', installed: false, active: false, enabled: false, detail: null }
  const uid = tryExec(env, 'id', ['-u']).trim()
  const list = tryExec(env, 'launchctl', ['print', `gui/${uid}/${MACOS_LABEL}`])
  const active = /state = running/.test(list)
  return {
    platform: 'darwin',
    installed,
    active,
    enabled: installed,
    detail: 'LaunchAgents run only while you are logged in and may pause under App Nap or sleep.',
  }
}

function tryExec(env: ServiceEnv, command: string, args: string[]): string {
  try { return env.exec(command, args) } catch { return '' }
}

export function startService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') { env.exec('systemctl', ['--user', 'start', LINUX_UNIT_NAME]); return }
  const uid = env.exec('id', ['-u']).trim()
  if (!tryExec(env, 'launchctl', ['print', `gui/${uid}/${MACOS_LABEL}`])) {
    env.exec('launchctl', ['enable', `gui/${uid}/${MACOS_LABEL}`])
    env.exec('launchctl', ['bootstrap', `gui/${uid}`, macosPlistPath(env.home)])
  } else env.exec('launchctl', ['kickstart', `gui/${uid}/${MACOS_LABEL}`])
}

export function stopService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') { env.exec('systemctl', ['--user', 'stop', LINUX_UNIT_NAME]); return }
  const uid = env.exec('id', ['-u']).trim()
  env.exec('launchctl', ['bootout', `gui/${uid}/${MACOS_LABEL}`])
}

export function restartService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') { env.exec('systemctl', ['--user', 'restart', LINUX_UNIT_NAME]); return }
  const uid = env.exec('id', ['-u']).trim()
  if (tryExec(env, 'launchctl', ['print', `gui/${uid}/${MACOS_LABEL}`])) env.exec('launchctl', ['kickstart', '-k', `gui/${uid}/${MACOS_LABEL}`])
  else startService(env)
}

/** Stops and removes the service definition. Leaves `~/.solus` untouched. */
export function uninstallService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'linux') {
    const unitPath = linuxUnitPath(env.home)
    if (existsSync(unitPath)) {
      env.exec('systemctl', ['--user', 'disable', '--now', LINUX_UNIT_NAME])
      rmSync(unitPath, { force: true })
      env.exec('systemctl', ['--user', 'daemon-reload'])
    }
    return
  }
  const plistPath = macosPlistPath(env.home)
  if (existsSync(plistPath)) {
    const uid = env.exec('id', ['-u']).trim()
    try { env.exec('launchctl', ['bootout', `gui/${uid}/${MACOS_LABEL}`]) } catch { /* already stopped */ }
    rmSync(plistPath, { force: true })
  }
}

/** True when a unit/plist this module wrote already exists — used to decide
 *  whether `solus setup` should install or just report the current state. */
export function hasServiceDefinition(home: string, platform: NodeJS.Platform): boolean {
  if (platform === 'linux') return existsSync(linuxUnitPath(home))
  if (platform === 'darwin') return existsSync(macosPlistPath(home))
  return false
}
