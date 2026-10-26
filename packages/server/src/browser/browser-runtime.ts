import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { BrowserRuntimeStatus } from '@solus/contracts/browser-runtime'
import { resolveHomePath } from '../platform/paths'
import { pinnedChromium } from './pinned-chromium'
import { browserWebviewHost } from './surface-driver'

interface BrowserRuntime {
  cli: string
  /** Launch once. No `executablePath` means Playwright's own Chromium. */
  verify(executablePath?: string): Promise<void>
}

/** The part of `PinnedChromium` the installer uses. */
interface PinnedBrowser {
  version: string
  installed(): string | null
  ensure(): Promise<string>
}

interface BrowserRuntimeDeps {
  native(): boolean
  load(): Promise<BrowserRuntime | null>
  /** Null where Chrome for Testing has no build for this host. */
  pinned: PinnedBrowser | null
  run(command: string, args: string[]): Promise<void>
  platform: string
  node: string
  isRoot: boolean
  browserPath?: string
}

async function loadRuntime(): Promise<BrowserRuntime | null> {
  try {
    const name = ['playwright', 'core'].join('-')
    const runtime: {
      chromium: { launch(options: { executablePath?: string; headless: boolean; timeout: number }): Promise<{ close(): Promise<void> }> }
    } = await import(name)
    const require = createRequire(import.meta.url)
    const cli = join(dirname(require.resolve(`${name}/package.json`)), 'cli.js')
    return {
      cli,
      async verify(executablePath) {
        const browser = await runtime.chromium.launch({ executablePath, headless: true, timeout: 10_000 })
        await browser.close()
      },
    }
  } catch {
    return null
  }
}

function runInstaller(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: resolveHomePath(homedir()),
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60_000,
      killSignal: 'SIGKILL',
    })
    let output = ''
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(output.trim() || 'The browser installer did not finish.'))
    })
  })
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** One job per host, independent of RPC timeouts and client connections. */
export class BrowserRuntimeInstaller {
  private state: BrowserRuntimeStatus | null = null
  private checking: Promise<BrowserRuntimeStatus> | null = null
  private readonly deps: BrowserRuntimeDeps

  constructor(deps: Partial<BrowserRuntimeDeps> = {}) {
    this.deps = {
      native: () => browserWebviewHost() !== null,
      load: loadRuntime,
      pinned: pinnedChromium(),
      run: runInstaller,
      platform: process.platform,
      node: process.execPath,
      isRoot: process.getuid?.() === 0,
      browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      ...deps,
    }
  }

  async status(): Promise<BrowserRuntimeStatus> {
    if (this.state?.phase === 'installing') return { ...this.state }
    if (this.checking) return this.checking
    this.checking = this.probe().finally(() => { this.checking = null })
    return this.checking
  }

  private async probe(): Promise<BrowserRuntimeStatus> {
    if (this.deps.native()) return { phase: 'builtin', message: 'Included with the desktop app.' }
    const runtime = await this.deps.load()
    if (!runtime || !['linux', 'darwin'].includes(this.deps.platform)) {
      return { phase: 'unsupported', message: 'This host cannot install Chromium. Update the standalone server package.' }
    }
    const { pinned } = this.deps
    try {
      if (!pinned) {
        await runtime.verify()
        return { phase: 'ready', message: 'Chromium is ready on this host.' }
      }
      // Playwright's own Chromium does not count: it trusts revoked CAs (pinned-chromium.ts).
      const executable = pinned.installed()
      if (!executable) throw new Error('The pinned Chromium is not installed.')
      await runtime.verify(executable)
      return { phase: 'ready', message: `Chromium ${pinned.version} is ready on this host.` }
    } catch {
      // Keep the last install failure so a reconnect explains what went wrong.
      return this.state?.phase === 'failed' ? { ...this.state } : {
        phase: 'missing', message: 'Install Chromium to view browser pages from this host.',
      }
    }
  }

  install(): BrowserRuntimeStatus {
    if (this.state?.phase === 'installing') return { ...this.state }
    this.state = { phase: 'installing', message: 'Checking this host…' }
    void this.performInstall()
    return { ...this.state }
  }

  private async performInstall(): Promise<void> {
    let manualCommand: string | undefined
    try {
      if (this.checking) await this.checking
      if (this.deps.native()) {
        this.state = { phase: 'builtin', message: 'Included with the desktop app.' }
        return
      }
      const runtime = await this.deps.load()
      if (!runtime || !['linux', 'darwin'].includes(this.deps.platform)) {
        this.state = { phase: 'unsupported', message: 'Update the standalone server package to install Chromium.' }
        return
      }
      const { pinned } = this.deps
      const withPath = (command: string) =>
        this.deps.browserPath ? `PLAYWRIGHT_BROWSERS_PATH=${quote(this.deps.browserPath)} ${command}` : command
      let executable: string | undefined
      if (pinned) {
        this.state = { phase: 'installing', message: `Downloading Chromium ${pinned.version}…` }
        executable = await pinned.ensure()
      }
      // The pinned build needs Playwright's Linux libraries, not its browser.
      manualCommand = pinned
        ? `${quote(this.deps.node)} ${quote(runtime.cli)} install-deps chromium`
        : withPath(`${quote(this.deps.node)} ${quote(runtime.cli)} install --with-deps chromium`)
      try {
        await runtime.verify(executable)
      } catch {
        if (!pinned) {
          this.state = { phase: 'installing', message: 'Downloading Chromium…' }
          await this.deps.run(this.deps.node, [runtime.cli, 'install', 'chromium'])
        }
        this.state = { phase: 'installing', message: 'Checking Chromium…' }
        try {
          await runtime.verify(executable)
        } catch (error) {
          if (this.deps.platform !== 'linux') throw error
          this.state = { phase: 'installing', message: 'Installing Linux browser libraries…' }
          const args = [runtime.cli, 'install-deps', 'chromium']
          // Never open a password prompt on the host's invisible stdin.
          if (this.deps.isRoot) await this.deps.run(this.deps.node, args)
          else await this.deps.run('sudo', ['-n', '--', this.deps.node, ...args])
          await runtime.verify(executable)
        }
      }
      this.state = { phase: 'ready', message: pinned ? `Chromium ${pinned.version} is ready on this host.` : 'Chromium is ready on this host.' }
    } catch (error) {
      this.state = {
        phase: 'failed',
        message: (error instanceof Error ? error.message : 'Browser installation failed.').slice(-2000),
        manualCommand,
      }
    }
  }
}
