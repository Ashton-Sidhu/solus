import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { httpsSource, providerMetadata } from './provider-download'
import { assertNativePlatform, detectExternalInstallation, softwareDigestSchema, softwareVersionSchema, type AgentSoftwareAdapter, type ExternalInstallation, type NativeRelease, type SoftwareSourceOptions } from './software-adapter'

const claudeManifestSchema = z.object({ platforms: z.record(z.string(), z.object({ checksum: softwareDigestSchema })) })
export interface ClaudeSoftwareOptions extends SoftwareSourceOptions { musl?: boolean; cpuInfo?: string }

export class ClaudeSoftwareAdapter implements AgentSoftwareAdapter {
  readonly agent = 'claude'
  readonly label = 'Claude Code'
  readonly npmPackage = '@anthropic-ai/claude-code'

  constructor(private readonly options: ClaudeSoftwareOptions = {}) {}

  get source(): 'mirror' | 'vendor' { return this.options.baseUrl || process.env.SOLUS_CLAUDE_RELEASE_BASE_URL ? 'mirror' : 'vendor' }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  private get arch(): string { return this.options.arch ?? process.arch }

  detectInstallation(path: string, realPath: string): ExternalInstallation {
    return detectExternalInstallation(path, realPath, {
      command: this.agent, npmPackage: this.npmPackage, brewPackage: 'claude-code', wingetPackage: 'Anthropic.ClaudeCode',
      nativeDirectory: ['.local', 'share', 'claude'], nativeRemediation: 'Run claude update on this host.',
    })
  }

  assertCompatible(): void {
    if (this.platform !== 'linux' || this.arch !== 'x64') return
    let cpuInfo = this.options.cpuInfo
    if (cpuInfo === undefined) {
      try { cpuInfo = readFileSync('/proc/cpuinfo', 'utf8') } catch { return }
    }
    if (!/(?:^|\s)sse4_2(?:\s|$)/m.test(cpuInfo)) throw new Error('Claude’s native installer requires SSE4.2, but this host’s CPU profile does not expose it. For a KVM/QEMU host, enable CPU passthrough (host) or an x86-64-v2-or-newer CPU model, then try again.')
  }

  async release(): Promise<NativeRelease> {
    assertNativePlatform(this.agent, this.platform, this.arch)
    const base = httpsSource(this.options.baseUrl ?? process.env.SOLUS_CLAUDE_RELEASE_BASE_URL ?? 'https://downloads.claude.ai/claude-code-releases')
    const metadata = this.options.metadata ?? providerMetadata
    const version = softwareVersionSchema.parse((await metadata(`${base}/latest`)).trim())
    const manifest = claudeManifestSchema.parse(JSON.parse(await metadata(`${base}/${version}/manifest.json`)))
    const report = this.platform === 'linux' && this.options.musl === undefined
      ? z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).safeParse(process.report?.getReport?.()) : null
    const musl = this.options.musl ?? (report?.success === true && !report.data.header.glibcVersionRuntime)
    const target = `${this.platform}-${this.arch}${this.platform === 'linux' && musl ? '-musl' : ''}`
    const asset = manifest.platforms[target]
    if (!asset) throw new Error(`The Claude release has no binary for ${target}.`)
    const binary = `claude${this.platform === 'win32' ? '.exe' : ''}`
    return { version, downloadUrl: `${base}/${version}/${target}/${binary}`, sha256: asset.checksum, archive: false, binary }
  }
}
