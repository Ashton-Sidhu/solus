import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostCliEnv, startableCommand } from '../cli-env'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { withUserScope } from '../vault/acting-scope'
import { AppProjectError, readAppBuild, type AppBuild } from './app-project'
import { appNode } from './app-node'

const log = createLogger('apps', 'app-builder.ts')

/**
 * The host's build (docs/plans/apps.md decision 4). A deploy checks out one
 * revision into the app's build folder, installs its dependencies when they
 * changed, and runs the host's own bundler. So the build of a version is the
 * build of its revision, and no agent decides what a version runs. A preview
 * runs the same bundler in the project folder, in place.
 *
 * The bundler loads the built backend once, to read what it declares. With
 * `SOLUS_APP_BUILD=host` that step runs under Node's permission model with no
 * network. Installing dependencies runs their own scripts, as it does in the
 * session that wrote the app: an app has no more rights than that session.
 */

const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUNDLE_TIMEOUT_MS = 5 * 60_000
const MAX_LOG_CHARACTERS = 64_000
const DEPENDENCY_FILES = ['package.json', 'package-lock.json']
/** What a build folder keeps between builds: the installed dependencies and the mark of what they were installed from. */
const KEPT_ENTRIES = new Set(['node_modules', '.solus-build'])

export interface AppBuildResult {
  build: AppBuild
  /** The end of what the install and the bundler printed. */
  log: string
  ms: number
}

/** A build that did not make a version. `log` is what the build printed up to its failure. */
export class AppBuildError extends Error {
  constructor(message: string, readonly log: string, readonly ms: number) {
    super(message)
    this.name = 'AppBuildError'
  }
}

export interface AppBuilder {
  /** Builds one revision in the app's build folder. `checkout` writes the revision's files into the folder it is given. */
  buildRevision(appId: string, checkout: (folder: string) => Promise<void>): Promise<AppBuildResult>
  /** Builds a project folder in place, for a preview. The project's own `node_modules` must be there. */
  buildProject(folder: string): Promise<AppBuildResult>
  /** Removes the app's build folder. */
  remove(appId: string): Promise<void>
}

export interface HostAppBuilderOptions {
  /** The host's bundler: the `bundle-artifact.mjs` of the installed Solus plugin. */
  bundler: () => string
  /** The Node that runs the bundler. Electron and Bun hosts use Node from the host's PATH. */
  node?: string
  root?: () => string
}

/** One program of a build that failed or took too long, with what it printed. */
class BuildStepError extends Error {
  constructor(message: string, readonly output: string) {
    super(message)
    this.name = 'BuildStepError'
  }
}

function tail(text: string): string {
  return text.length > MAX_LOG_CHARACTERS ? `…\n${text.slice(-MAX_LOG_CHARACTERS)}` : text
}

/** Runs one program of a build and answers what it printed. A program that fails, or takes too long, throws with what it printed. */
function runStep(file: string, args: readonly string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  // A build is the host's own work, not a person's process.
  return withUserScope(null, () => new Promise<string>((resolve, reject) => {
    const env = hostCliEnv({ NODE_NO_WARNINGS: '1', npm_config_update_notifier: 'false', ...extraEnv })
    const command = startableCommand(file, env)
    const child = spawn(command.file, [...command.args, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (text: string) => {
      output = (output + text).slice(-MAX_LOG_CHARACTERS * 2)
    }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    const timer = setTimeout(() => {
      collect(`\nStopped after ${Math.round(timeoutMs / 60_000)} minutes.\n`)
      child.kill()
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new BuildStepError(`${file} could not start: ${error.message}`, output))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new BuildStepError(`${file} ended with an error.`, output))
    })
  }))
}

/** The last line of a build's text that says something: what a receipt gives as the reason. */
function lastLine(text: string): string {
  return text.trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''
}

export class HostAppBuilder implements AppBuilder {
  /** One build at a time for each app: two would write the same folder. */
  private readonly builds = new Map<string, Promise<void>>()

  constructor(private readonly options: HostAppBuilderOptions) {}

  private folder(appId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error('This app has no build folder: its id is not a folder name.')
    return join((this.options.root ?? (() => join(dataDir(), 'apps', 'builds')))(), appId)
  }

  private node(): string {
    return this.options.node ?? appNode()
  }

  buildRevision(appId: string, checkout: (folder: string) => Promise<void>): Promise<AppBuildResult> {
    const before = this.builds.get(appId) ?? Promise.resolve()
    const result = before.catch(() => {}).then(() => this.buildIn(this.folder(appId), checkout))
    const done = result.then(() => {}, () => {})
    this.builds.set(appId, done)
    void done.finally(() => {
      if (this.builds.get(appId) === done) this.builds.delete(appId)
    })
    return result
  }

  async buildProject(folder: string): Promise<AppBuildResult> {
    const startedAt = Date.now()
    const installed = await stat(join(folder, 'node_modules')).then((entry) => entry.isDirectory(), () => false)
    if (!installed) throw new AppBuildError('This project has no node_modules. Run `npm install` in it first.', '', 0)
    return this.bundle(folder, '', startedAt)
  }

  async remove(appId: string): Promise<void> {
    await this.builds.get(appId)
    await rm(this.folder(appId), { recursive: true, force: true })
  }

  private async buildIn(folder: string, checkout: (folder: string) => Promise<void>): Promise<AppBuildResult> {
    const startedAt = Date.now()
    await mkdir(folder, { recursive: true })
    // The folder holds one revision at a time: what the revision before it left must not be built.
    for (const entry of await readdir(folder)) if (!KEPT_ENTRIES.has(entry)) await rm(join(folder, entry), { recursive: true, force: true })
    await checkout(folder)
    let text = ''
    const dependencies = await this.dependencyHash(folder)
    const installedFrom = await readFile(join(folder, '.solus-build'), 'utf8').catch(() => '')
    if (dependencies !== installedFrom.trim()) {
      try {
        text += await runStep('npm', ['install', '--no-audit', '--no-fund'], folder, INSTALL_TIMEOUT_MS)
      } catch (error) {
        const output = text + (error instanceof BuildStepError ? error.output : '')
        throw new AppBuildError(`The dependencies did not install: ${lastLine(output) || (error instanceof Error ? error.message : String(error))}`, tail(output), Date.now() - startedAt)
      }
      await writeFile(join(folder, '.solus-build'), dependencies)
    }
    return this.bundle(folder, text, startedAt)
  }

  private async bundle(folder: string, before: string, startedAt: number): Promise<AppBuildResult> {
    let text = before
    try {
      text += await runStep(this.node(), [this.options.bundler(), folder], folder, BUNDLE_TIMEOUT_MS, { SOLUS_APP_BUILD: 'host' })
    } catch (error) {
      const output = text + (error instanceof BuildStepError ? error.output : '')
      throw new AppBuildError(`The build failed: ${lastLine(output) || (error instanceof Error ? error.message : String(error))}`, tail(output), Date.now() - startedAt)
    }
    try {
      const build = await readAppBuild(folder)
      const ms = Date.now() - startedAt
      log.info('app_built', { folder, ms })
      return { build, log: tail(text), ms }
    } catch (error) {
      if (error instanceof AppProjectError) throw new AppBuildError(error.message, tail(text), Date.now() - startedAt)
      throw error
    }
  }

  /** What the dependencies of a revision are installed from: when it changes, the build installs again. */
  private async dependencyHash(folder: string): Promise<string> {
    const hash = createHash('sha256')
    for (const name of DEPENDENCY_FILES) hash.update(await readFile(join(folder, name)).catch(() => Buffer.alloc(0))).update('\0')
    return hash.digest('hex')
  }
}
