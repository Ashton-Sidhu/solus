import { spawn } from 'node:child_process'
import { z } from 'zod'
import { codexVersionProblem } from '../execution/agents/codex/codex-agent'
import { httpsSource, providerMetadata } from './provider-download'
import { assertNativePlatform, detectExternalInstallation, softwareDigestSchema, softwareVersionSchema, type AgentSoftwareAdapter, type ExternalInstallation, type NativeRelease, type SoftwareSourceOptions } from './software-adapter'

const codexReleaseSchema = z.object({ tag_name: z.string(), assets: z.array(z.object({ name: z.string(), digest: z.string() })) })
const initializedSchema = z.object({ id: z.literal(1), result: z.object({ userAgent: z.string() }) })

export class CodexSoftwareAdapter implements AgentSoftwareAdapter {
  readonly agent = 'codex'
  readonly label = 'Codex'
  readonly npmPackage = '@openai/codex'
  readonly verifyProtocol = verifyCodexProtocol

  constructor(private readonly options: SoftwareSourceOptions = {}) {}

  get source(): 'mirror' | 'vendor' { return this.options.baseUrl || process.env.SOLUS_CODEX_RELEASE_BASE_URL ? 'mirror' : 'vendor' }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  private get arch(): string { return this.options.arch ?? process.arch }

  detectInstallation(path: string, realPath: string): ExternalInstallation {
    return detectExternalInstallation(path, realPath, {
      command: this.agent, npmPackage: this.npmPackage, brewPackage: 'codex', wingetPackage: 'OpenAI.Codex',
      nativeDirectory: ['.codex', 'packages', 'standalone'], nativeRemediation: 'Update Codex with its standalone installer on this host.',
    })
  }

  async release(): Promise<NativeRelease> {
    assertNativePlatform(this.agent, this.platform, this.arch)
    const base = httpsSource(this.options.baseUrl ?? process.env.SOLUS_CODEX_RELEASE_BASE_URL ?? 'https://releases.openai.com/codex')
    const metadata = this.options.metadata ?? providerMetadata
    const release = codexReleaseSchema.parse(JSON.parse(await metadata(`${base}/channels/latest`)))
    const version = softwareVersionSchema.parse(release.tag_name.replace(/^rust-v/, ''))
    const target = `${this.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${this.platform === 'darwin' ? 'apple-darwin' : this.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`
    const name = `codex-package-${target}.tar.gz`
    const asset = release.assets.find((entry) => entry.name === name)
    if (!asset) throw new Error(`The Codex release has no package for ${this.platform}/${this.arch}.`)
    return { version, downloadUrl: `${base}/releases/${version}/${name}`, digest: { algorithm: 'sha256', hex: softwareDigestSchema.parse(asset.digest.replace(/^sha256:/, '')) }, archive: true, binary: `bin/codex${this.platform === 'win32' ? '.exe' : ''}` }
  }
}

function verifyCodexProtocol(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://', '--enable', 'default_mode_request_user_input'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    let settled = false
    let outcome: Error | null = null
    const timer = setTimeout(() => finish(new Error('The downloaded Codex app-server did not initialize within 15 seconds.')), 15_000)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      outcome = error
      clearTimeout(timer)
      child.stdin.end()
      // Only this probe's captured child is stopped. No active agent is touched.
      child.kill()
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 1000)
      killTimer.unref?.()
    }
    child.on('error', () => finish(new Error('The downloaded Codex app-server did not start.')))
    child.stdin.on('error', () => finish(new Error('The downloaded Codex app-server closed its input.')))
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      buffer += chunk.toString('utf8')
      if (buffer.length > 64 * 1024) return finish(new Error('The Codex initialization response was too large.'))
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const response = initializedSchema.safeParse(JSON.parse(line))
          if (response.success) {
            const problem = codexVersionProblem(response.data.result.userAgent)
            return finish(problem ? new Error(problem) : null)
          }
        } catch { /* A non-protocol line is not an initialization response. */ }
      }
    })
    child.once('close', () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (!settled) outcome = new Error('The downloaded Codex app-server exited before initialization.')
      if (outcome) reject(outcome)
      else resolve()
    })
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'Solus', title: null, version: '0.7.0' }, capabilities: { experimentalApi: true, optOutNotificationMethods: null } } })}\n`)
  })
}
