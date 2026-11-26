import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SetupAgent } from '@solus/contracts/types'
import type { ProviderInstallation, ProviderUpdateOperation, ProviderUpdateStatus } from '@solus/contracts/host-update-types'
import { AgentExecutable, agentExecutables, findOnPath, getCliPath, hostCliEnv, startableCommand, type AgentSelection } from '../cli-env'
import { createLogger } from '../logger'
import { reduceCheckState } from './check-state'
import { downloadProviderFile } from './provider-download'
import { softwareVersionSchema, type AgentSoftwareAdapter } from './software-adapter'
import { readExecutableVersion } from './provider-versions'

const log = createLogger('updates', 'agent-software.ts')
export interface AgentSoftwareOptions {
  root?: string
  automatic?: () => boolean
  canCheck?: () => boolean
  canInstall?: () => boolean
  assertInstallAllowed?: () => void
  existingBinary?: () => string | null
  version?: (binary: string) => Promise<string | null>
  npmView?: (spec: string) => Promise<string | null>
  download?: (url: string, destination: string) => Promise<void>
  verify?: (binary: string, version: string) => Promise<void>
  now?: () => number
}

/** One agent's software on one host. Emits `changed` after its status changes. */
export class AgentSoftware extends EventEmitter {
  readonly status: ProviderUpdateStatus
  private readonly executable: AgentExecutable
  readonly agent: SetupAgent
  private checking: Promise<void> | null = null
  private installing: Promise<void> | null = null
  private revision = 0
  private lastAutomaticAttempt = -Infinity

  constructor(private readonly adapter: AgentSoftwareAdapter, private readonly options: AgentSoftwareOptions = {}) {
    super()
    const agent = adapter.agent
    this.agent = agent
    this.executable = options.root ? new AgentExecutable(agent, options.root) : agentExecutables[agent]
    this.status = { agent, installedVersion: null, check: { kind: 'idle', reason: null } }
  }

  get isUpdating(): boolean { return this.installing !== null }

  refreshInstallation(): void {
    this.status.installation = this.discoverInstallation()
    this.changed()
  }

  check(): Promise<void> {
    if (this.options.canCheck?.() === false) return Promise.resolve()
    if (this.checking) return this.checking
    this.checking = this.checkOnce().finally(() => {
      this.checking = null
      this.updateAutomatically()
    })
    return this.checking
  }

  /** No choice updates the current managed install; migration must be explicit. */
  install(selection?: 'native' | 'existing'): Promise<void> {
    if (this.installing) {
      if (selection === 'existing') return Promise.reject(new Error('Wait for the current agent update to finish, then change installations.'))
      return this.installing
    }
    this.installing = this.installOnce(selection).finally(() => { this.installing = null })
    return this.installing
  }

  private changed(): void {
    try { this.emit('changed') }
    catch { log.warn('provider_update_status_failed', { agent: this.agent }) }
  }

  private get now(): number { return (this.options.now ?? Date.now)() }
  private get existingBinary(): string | null { return this.options.existingBinary ? this.options.existingBinary() : findOnPath(this.agent, getCliPath(), false) }

  private discoverInstallation(): ProviderInstallation {
    const source = this.adapter.source
    const path = this.executable.binary ?? this.existingBinary
    if (!path) return { method: 'absent', managed: false, path: null, canUpdate: true, remediation: null, source, automatic: false }
    let real: string
    try { real = realpathSync(path) } catch { real = path }
    if (this.executable.owns(real)) return { method: 'native', managed: true, path, canUpdate: true, remediation: null, source, automatic: this.options.automatic?.() === true && this.options.canCheck?.() !== false, existingPath: this.existingBinary }
    const { method, remediation } = this.adapter.detectInstallation(path, real)
    return { method, managed: false, path, canUpdate: false, remediation, source: method === 'npm' ? 'npm' : source, automatic: false }
  }

  private async checkOnce(): Promise<void> {
    const revision = this.revision
    const previous = this.status.check
    const latestVersion = 'latestVersion' in previous ? previous.latestVersion : null
    this.status.check = { kind: 'checking' }
    try {
      const installation = this.discoverInstallation()
      this.status.installation = installation
      this.changed()
      const current = installation.path ? await (this.options.version ?? readExecutableVersion)(installation.path) : null
      if (revision !== this.revision) return
      this.status.installedVersion = current
      if (!current) this.status.check = { kind: 'idle', reason: 'Not installed' }
      else {
        const latest = installation.method === 'npm' ? await this.npmVersion() : (await this.adapter.release()).version
        if (revision !== this.revision) return
        this.status.check = reduceCheckState(this.status.check, { kind: 'result', current, latest, now: this.now })
      }
    } catch (error) {
      if (revision !== this.revision) return
      const message = error instanceof Error ? error.message : String(error)
      this.status.check = { kind: 'error', message, latestVersion, checkedAt: this.now }
      log.warn('host_update_check_failed', { target: this.agent, error: message })
    }
    this.changed()
  }

  private updateAutomatically(): void {
    const installation = this.status.installation
    if (this.installing || this.status.check.kind !== 'available' || !installation?.managed || !installation.automatic || this.options.canInstall?.() === false) return
    if (this.now - this.lastAutomaticAttempt < 4 * 60 * 60 * 1000) return
    this.lastAutomaticAttempt = this.now
    void this.install().catch((error) => { log.warn('provider_auto_update_failed', { agent: this.agent, error: error instanceof Error ? error.message : String(error) }) })
  }

  private async installOnce(selection?: 'native' | 'existing'): Promise<void> {
    this.options.assertInstallAllowed?.()
    if (this.options.canInstall?.() === false) throw new Error('Agent updates are not allowed on this host now.')
    const installation = this.discoverInstallation()
    if (!selection && !installation.canUpdate) throw new Error(installation.remediation ?? 'Update this agent with its existing installer on the host.')
    if (selection === 'existing' && !this.existingBinary) throw new Error('There is no other installation on this host’s PATH.')
    if (selection === 'existing') await this.selectExisting()
    else await this.installNative()
    await this.checking
    await this.check()
  }

  private setOperation(phase: ProviderUpdateOperation['phase'], version: string | null, message: string | null = null): void {
    this.status.update = { phase, version, message, updatedAt: this.now }
    if (phase === 'succeeded' && version) {
      this.status.installedVersion = version
      const latest = 'latestVersion' in this.status.check ? this.status.check.latestVersion : null
      this.status.check = reduceCheckState(this.status.check, { kind: 'result', current: version, latest: latest ?? version, now: this.now })
    }
    this.refreshInstallation()
  }

  private async selectExisting(): Promise<void> {
    const root = this.executable.root
    const unlock = await lockInstaller(root)
    try {
      const selection = this.executable.selection
      if (!selection) throw new Error('There is no native Solus installation to deselect.')
      await this.selectPackage({ ...selection, enabled: false })
      this.setOperation('succeeded', null, 'The existing installation is selected. Active turns keep their current version.')
    } finally { await unlock() }
  }

  private async selectPackage(selection: AgentSelection): Promise<void> {
    const root = this.executable.root
    const next = join(root, `current-${randomUUID()}.json`)
    try {
      await writeFile(next, JSON.stringify(selection), { mode: 0o600 })
      await rename(next, join(root, 'current.json'))
      this.revision++
    } finally { await rm(next, { force: true }) }
  }

  private async installNative(): Promise<void> {
    const root = this.executable.root
    await mkdir(root, { recursive: true })
    let unlock: (() => Promise<void>) | null = null
    let staging: string | null = null
    let version: string | null = null
    const previous = this.executable.selection
    const unchanged = previous && previous.enabled !== false ? `The previous agent version ${previous.version} remains selected.` : 'No installed agent was replaced.'
    try {
      unlock = await lockInstaller(root)
      this.adapter.assertCompatible?.()
      this.setOperation('downloading', version)
      const release = await this.adapter.release()
      version = release.version
      this.setOperation('downloading', version)
      staging = await mkdtemp(join(root, '.download-'))
      const payload = join(staging, 'payload')
      await (this.options.download ?? downloadProviderFile)(release.downloadUrl, payload)
      this.setOperation('verifying', version)
      const hash = createHash(release.digest.algorithm)
      for await (const chunk of createReadStream(payload)) hash.update(chunk)
      if (hash.digest('hex') !== release.digest.hex) throw new Error(`The agent download failed ${release.digest.algorithm === 'sha256' ? 'SHA-256' : 'SHA-512'} verification.`)
      const packagePath = join(staging, 'package')
      await mkdir(packagePath)
      if (release.archive) await extractPackage(payload, packagePath)
      else await rename(payload, join(packagePath, release.binary))
      await makeExecutable(packagePath)
      const binary = join(packagePath, release.binary)
      if (this.options.verify) await this.options.verify(binary, version)
      else await this.verifyPackage(binary, version)
      const releaseName = `${version}-${randomUUID()}`
      await mkdir(join(root, 'releases'), { recursive: true })
      await rename(packagePath, join(root, 'releases', releaseName))
      await this.selectPackage({ release: releaseName, binary: release.binary, version })
      await this.removeReleasesExcept([releaseName, previous?.release])
      this.setOperation('succeeded', version, `${this.adapter.label} ${version} is ready for new processes. Active turns continue with their current version.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.setOperation('failed', version, `${reason} ${unchanged}`)
      throw new Error(`${reason} ${unchanged}`)
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => { log.warn('provider_update_cleanup_failed', { agent: this.agent }) })
      await unlock?.().catch(() => { log.warn('provider_update_unlock_failed', { agent: this.agent }) })
    }
  }

  /**
   * Keeps the new release and the one it replaced, which a running turn may
   * still use; the next install removes that one. Each install extracts a new
   * folder, so without this every update left a full copy behind.
   */
  private async removeReleasesExcept(keep: Array<string | undefined>): Promise<void> {
    const releases = join(this.executable.root, 'releases')
    for (const name of await readdir(releases).catch((): string[] => [])) {
      if (keep.includes(name)) continue
      await rm(join(releases, name), { recursive: true, force: true })
        .catch(() => { log.warn('agent_release_remove_failed', { agent: this.agent, release: name }) })
    }
  }

  private async verifyPackage(binary: string, version: string): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'solus-agent-health-'))
    const host = hostCliEnv()
    const env: NodeJS.ProcessEnv = { PATH: host.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' }
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
      if (host[name]) env[name] = host[name]
    }
    try {
      if (await readExecutableVersion(binary, env, 10_000) !== version) throw new Error(`The downloaded ${this.agent} executable did not report version ${version}.`)
      await this.adapter.verifyProtocol?.(binary, env)
    } finally { await rm(home, { recursive: true, force: true }) }
  }

  private async npmVersion(): Promise<string> {
    if (!this.adapter.npmPackage) throw new Error(`${this.adapter.label} is not published to npm.`)
    const spec = `${this.adapter.npmPackage}@latest`
    const output = this.options.npmView ? await this.options.npmView(spec) : await new Promise<string | null>((resolve, reject) => {
      const env = hostCliEnv()
      const command = startableCommand('npm', env)
      execFile(command.file, [...command.args, 'view', spec, 'version', '--json'], { env, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error?.code === 'ENOENT') return resolve(null)
        if (error) reject(new Error(`npm could not read ${spec}.`))
        else resolve(stdout)
      })
    })
    if (output === null) throw new Error('npm is required to check this npm installation. Restore npm on this host, then check again.')
    try { return softwareVersionSchema.parse(JSON.parse(output)) }
    catch { throw new Error(`npm returned an unknown version for ${this.adapter.npmPackage}.`) }
  }
}

async function lockInstaller(root: string): Promise<() => Promise<void>> {
  const path = join(root, 'update.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(path, 'wx', 0o600)
      await lock.writeFile(String(process.pid))
      await lock.close()
      return () => rm(path, { force: true })
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const pid = Number(await readFile(path, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('An agent update lock is incomplete. Check the host before removing update.lock.')
      try { process.kill(pid, 0) } catch (probeError) {
        if (probeError instanceof Error && 'code' in probeError && probeError.code === 'ESRCH') {
          await rm(path, { force: true })
          continue
        }
      }
      throw new Error('An agent update is already running on this host.')
    }
  }
  throw new Error('Could not acquire the agent update lock.')
}

function runTar(args: string[]): Promise<string> {
  const env = hostCliEnv()
  const command = startableCommand('tar', env)
  return new Promise((resolve, reject) => {
    execFile(command.file, [...command.args, ...args], { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('The native agent package could not be extracted. Check that tar is installed on this host.'))
      else resolve(stdout)
    })
  })
}

async function extractPackage(archive: string, destination: string): Promise<void> {
  const files = await runTar(['-tzf', archive])
  const entries = await runTar(['-tvzf', archive])
  validateNativeArchive(files, entries)
  await runTar(['-xzf', archive, '-C', destination])
}

function validateNativeArchive(fileList: string, entryList: string): void {
  const files = fileList.split('\n').filter(Boolean)
  if (!files.length || files.some((path) => isAbsolute(path) || /^[a-z]:/i.test(path) || path.replaceAll('\\', '/').split('/').includes('..'))) throw new Error('The native package has an invalid file path.')
  // Published packages contain regular files and directories. Refuse links and
  // special files before extraction, including links that could redirect a later entry.
  const entries = entryList.split('\n').filter(Boolean)
  if (entries.length !== files.length) throw new Error('The native package file list is incomplete.')
  if (entries.some((entry) => entry[0] !== '-' && entry[0] !== 'd')) throw new Error('The native package contains a link or special file.')
}

async function makeExecutable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await makeExecutable(path)
    else if (entry.isFile()) await chmod(path, 0o755)
    else throw new Error('The native package contains a link or special file.')
  }
}
