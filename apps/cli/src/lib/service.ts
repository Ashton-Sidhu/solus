/**
 * The per-user native service (`solus setup`, `solus service ...`). Linux
 * uses a systemd user unit; macOS uses a LaunchAgent; Windows uses a Task
 * Scheduler logon task (`docs/plans/windows.md` §5.9). All point at the
 * stable launcher (`~/.local/bin/solus start`), never a version-specific
 * path, so an update never needs to touch the unit definition.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { defaultDataDir, launcherPath, readLockFile, windowsSystemTool } from './runtime'

export type ServiceExec = (command: string, args: string[]) => string

export function defaultServiceExec(command: string, args: string[]): string {
  // stderr is kept with the error, not printed: an expected failure (ending a task that is not running) is not news.
  return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

const LINUX_UNIT_NAME = 'solus.service'
const MACOS_LABEL = 'sh.solus.server'
export const WINDOWS_TASK_NAME = 'Solus server'

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
ExecStart=${unitQuote(posix.join(binDir, 'solus'))} start${env?.dataDir ? ` --data-dir ${unitQuote(env.dataDir)}` : ''}
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

export function macosPlistContent(binDir: string, logFile: string, env?: ServiceEnv): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(posix.join(binDir, 'solus'))}</string>
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

export interface WindowsTaskOptions {
  /** `DOMAIN\user`: the task runs as this account, at its logon only. */
  user: string
  launcher: string
  systemRoot: string
  dataDir?: string
  runtimeDir?: string
  host?: string
  port?: string
}

/** A value inside a quoted `cmd.exe` argument. Windows paths cannot hold `"`;
 *  `%` would expand as a variable, so both are refused. */
function cmdQuote(value: string): string {
  if (/["%\r\n]/.test(value)) throw new Error(`The Solus logon task cannot use a value with ", %, or a line break: ${value}`)
  return `"${value}"`
}

/**
 * The task's program and its arguments. A task action cannot set environment
 * variables, so `cmd.exe` sets them and then runs the launcher.
 * `conhost.exe --headless` gives the console programs a console with no
 * window, so no window opens at logon. The server writes its own log file.
 */
export function windowsTaskAction(options: WindowsTaskOptions) {
  const start = [
    // Task Scheduler does not restart a program that crashed; the supervisor does.
    `set ${cmdQuote('SOLUS_SUPERVISOR_RESTARTS=1')}&& `,
    options.runtimeDir ? `set ${cmdQuote(`SOLUS_RUNTIME_DIR=${options.runtimeDir}`)}&& ` : '',
    `${cmdQuote(options.launcher)} start`,
    options.dataDir ? ` --data-dir ${cmdQuote(options.dataDir)}` : '',
    options.host ? ` --host ${cmdQuote(options.host)}` : '',
    options.port ? ` --port ${cmdQuote(options.port)}` : '',
  ].join('')
  return {
    command: windowsSystemTool('conhost.exe', options.systemRoot),
    // `/s /c "..."`: cmd removes only the outer quotes and runs the rest as written.
    arguments: `--headless ${cmdQuote(windowsSystemTool('cmd.exe', options.systemRoot))} /d /s /c "${start}"`,
  }
}

/**
 * The task definition for `schtasks /create /xml`. It starts at the user's
 * logon with that user's token and no elevation, so no administrator rights
 * are needed. It has no time limit, and Task Scheduler restarts it every
 * minute when it fails, up to 999 times.
 */
export function windowsTaskXml(options: WindowsTaskOptions): string {
  const action = windowsTaskAction(options)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the Solus server while you are signed in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(options.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(options.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(action.command)}</Command>
      <Arguments>${xml(action.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

export interface ServiceStatus {
  platform: 'linux' | 'darwin' | 'win32'
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

export function isServicePlatform(platform: NodeJS.Platform): platform is 'linux' | 'darwin' | 'win32' {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
}

function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is 'linux' | 'darwin' | 'win32' {
  if (!isServicePlatform(platform)) {
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
  if (env.platform === 'win32') installWindowsService(env)
  else installMacService(env)
  return { lingerAdvice: null }
}

/** This account's SID. A name is not reliable: an SSH session sets USERDOMAIN to WORKGROUP, which names no account. */
function windowsUserSid(env: ServiceEnv): string {
  const line = env.exec(windowsSystemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const sid = /"(S-1-[\d-]+)"/.exec(line)?.[1]
  if (!sid) throw new Error('Windows did not name this account, so the Solus logon task has no account to run as.')
  return sid
}

function windowsTaskOptionsFor(env: ServiceEnv): WindowsTaskOptions {
  return {
    user: windowsUserSid(env),
    launcher: launcherPath(env.binDir, 'win32'),
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
    dataDir: env.dataDir,
    runtimeDir: env.runtimeDir,
    host: env.host,
    port: env.port,
  }
}

function installWindowsService(env: ServiceEnv): void {
  const schtasks = windowsSystemTool('schtasks.exe')
  const definition = windowsTaskXml(windowsTaskOptionsFor(env))
  const directory = mkdtempSync(join(tmpdir(), 'solus-task-'))
  try {
    const file = join(directory, 'solus-task.xml')
    // Task Scheduler reads the XML in the encoding it declares, UTF-16 with a byte order mark.
    writeFileSync(file, Buffer.from(`\ufeff${definition}`, 'utf16le'))
    tryExec(env, schtasks, ['/end', '/tn', WINDOWS_TASK_NAME])
    env.exec(schtasks, ['/create', '/tn', WINDOWS_TASK_NAME, '/xml', file, '/f'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  env.exec(schtasks, ['/run', '/tn', WINDOWS_TASK_NAME])
}

/** The task state from PowerShell: `Ready`, `Running`, `Disabled`, or `Queued`.
 *  It is not translated, as the `schtasks /query` text is. Empty when there is no task. */
function windowsTaskState(env: ServiceEnv): string {
  return tryExec(env, windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction Stop).State`,
  ]).trim()
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
  if (env.platform === 'win32') {
    const state = windowsTaskState(env)
    if (!state) return { platform: 'win32', installed: false, active: false, enabled: false, detail: null }
    return {
      platform: 'win32',
      installed: true,
      active: state === 'Running',
      enabled: state !== 'Disabled',
      detail: 'The logon task runs Solus only while you are signed in to Windows.',
    }
  }
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

/**
 * Ends the logon task and the server it started. `schtasks /end` ends only the
 * task's own processes; the server the supervisor started keeps running, holds
 * the port, and the next start finds it there. The server's PID is in its lock
 * file, and it is ended only when that PID is still this install's server.
 * Neither end is a clean shutdown: SQLite recovers from its WAL, and the next
 * start replaces the lock of a dead process.
 */
function endWindowsTask(env: ServiceEnv): void {
  tryExec(env, windowsSystemTool('schtasks.exe'), ['/end', '/tn', WINDOWS_TASK_NAME])
  const dataDir = env.dataDir ?? defaultDataDir()
  const lock = readLockFile(join(dataDir, 'server.lock'))
  if (!lock) return
  const commandLine = tryExec(env, windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${lock.pid}').CommandLine`,
  ])
  if (!commandLine.includes('standalone.js') || !commandLine.includes(dataDir)) return
  tryExec(env, windowsSystemTool('taskkill.exe'), ['/T', '/F', '/PID', String(lock.pid)])
}

export function startService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'win32') { env.exec(windowsSystemTool('schtasks.exe'), ['/run', '/tn', WINDOWS_TASK_NAME]); return }
  if (env.platform === 'linux') { env.exec('systemctl', ['--user', 'start', LINUX_UNIT_NAME]); return }
  const uid = env.exec('id', ['-u']).trim()
  if (!tryExec(env, 'launchctl', ['print', `gui/${uid}/${MACOS_LABEL}`])) {
    env.exec('launchctl', ['enable', `gui/${uid}/${MACOS_LABEL}`])
    env.exec('launchctl', ['bootstrap', `gui/${uid}`, macosPlistPath(env.home)])
  } else env.exec('launchctl', ['kickstart', `gui/${uid}/${MACOS_LABEL}`])
}

export function stopService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'win32') { endWindowsTask(env); return }
  if (env.platform === 'linux') { env.exec('systemctl', ['--user', 'stop', LINUX_UNIT_NAME]); return }
  const uid = env.exec('id', ['-u']).trim()
  env.exec('launchctl', ['bootout', `gui/${uid}/${MACOS_LABEL}`])
}

export function restartService(env: ServiceEnv): void {
  assertSupportedPlatform(env.platform)
  if (env.platform === 'win32') {
    endWindowsTask(env)
    startService(env)
    return
  }
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
  if (env.platform === 'win32') {
    if (!windowsTaskState(env)) return
    endWindowsTask(env)
    env.exec(windowsSystemTool('schtasks.exe'), ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'])
    return
  }
  const plistPath = macosPlistPath(env.home)
  if (existsSync(plistPath)) {
    const uid = env.exec('id', ['-u']).trim()
    try { env.exec('launchctl', ['bootout', `gui/${uid}/${MACOS_LABEL}`]) } catch { /* already stopped */ }
    rmSync(plistPath, { force: true })
  }
}
