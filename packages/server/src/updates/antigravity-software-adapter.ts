/**
 * The Antigravity CLI (`agy`) for the agent software installer
 * (docs/plans/antigravity-provider.md §6).
 *
 * The manifest address, the target names, and the package address rule port
 * T3 Code (`pingdotgg/t3code` commit b8ef0600,
 * `apps/server/src/provider/antigravityCliRelease.ts`):
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { access, constants } from 'node:fs/promises'
import { z } from 'zod'
import { agentExecutables } from '../cli-env'
import { httpsSource, providerMetadata } from './provider-download'
import { readExecutableVersion } from './provider-versions'
import { assertNativePlatform, softwareVersionSchema, type AgentSoftwareAdapter, type ExternalInstallation, type NativeRelease, type SoftwareSourceOptions } from './software-adapter'

export const ANTIGRAVITY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const PACKAGE_PREFIX = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/'
/** `agy` unpacks about 1 GB before it answers `--version`. */
const EXTERNAL_VERSION_TIMEOUT_MS = 60_000

const manifestSchema = z.object({
  version: softwareVersionSchema,
  url: z.string(),
  sha512: z.string().regex(/^[a-fA-F0-9]{128}$/),
})

export interface AntigravitySourceOptions extends SoftwareSourceOptions {
  /** Linux with musl instead of glibc. */
  musl?: boolean
}

/** The manifest name of a platform: `darwin_arm64`, `linux_amd64_musl`, `windows_amd64`. */
export function antigravityTarget(platform: NodeJS.Platform, arch: string, musl: boolean): string {
  const os = platform === 'win32' ? 'windows' : platform
  return `${os}_${arch === 'x64' ? 'amd64' : arch}${platform === 'linux' && musl ? '_musl' : ''}`
}

/** The package must be Google's own file for exactly this platform. */
function packageMatches(url: string, version: string, platform: NodeJS.Platform, arch: string, musl: boolean): boolean {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
  const cpu = arch === 'x64' ? 'x64' : 'arm64'
  const suffix = platform === 'linux' && musl ? '_musl' : ''
  const extension = platform === 'win32' ? 'exe' : 'tar.gz'
  const folder = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'arm' : 'x64'}${suffix ? '-musl' : ''}`
  const prefix = `${PACKAGE_PREFIX}${version}-`
  if (!url.startsWith(prefix)) return false
  const rest = url.slice(prefix.length)
  return /^\d+\//.test(rest) && rest.replace(/^\d+\//, '') === `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
}

/** Whether this Linux runs on musl: Node reports no glibc version there. */
const processReportSchema = z.looseObject({ header: z.looseObject({ glibcVersionRuntime: z.string().optional() }).optional() })
function hostUsesMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = processReportSchema.safeParse(process.report?.getReport())
  return !(report.success && report.data.header?.glibcVersionRuntime)
}

export class AntigravitySoftwareAdapter implements AgentSoftwareAdapter {
  readonly agent = 'agy'
  readonly label = 'Google Antigravity'
  /** agy is not published to npm. */
  readonly npmPackage = null

  constructor(private readonly options: AntigravitySourceOptions = {}) {}

  get source(): 'mirror' | 'vendor' { return this.options.baseUrl || process.env.SOLUS_AGY_RELEASE_BASE_URL ? 'mirror' : 'vendor' }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  private get arch(): string { return this.options.arch ?? process.arch }
  private get musl(): boolean { return this.options.musl ?? hostUsesMusl() }

  /** Google names no package manager for agy, so any copy Solus did not install is updated where it came from. */
  detectInstallation(path: string): ExternalInstallation {
    return { method: 'external', remediation: `Update agy at ${path} with the installer you used, or install the Solus copy.` }
  }

  async release(): Promise<NativeRelease> {
    assertNativePlatform(this.agent, this.platform, this.arch)
    const base = httpsSource(this.options.baseUrl ?? process.env.SOLUS_AGY_RELEASE_BASE_URL ?? ANTIGRAVITY_MANIFEST_BASE)
    const metadata = this.options.metadata ?? providerMetadata
    const manifest = manifestSchema.parse(JSON.parse(await metadata(`${base}/${antigravityTarget(this.platform, this.arch, this.musl)}.json`)))
    if (!packageMatches(manifest.url, manifest.version, this.platform, this.arch, this.musl)) {
      throw new Error(`The Google Antigravity release for ${this.platform}/${this.arch} names an unexpected download address.`)
    }
    const windows = this.platform === 'win32'
    return {
      version: manifest.version,
      downloadUrl: manifest.url,
      digest: { algorithm: 'sha512', hex: manifest.sha512.toLowerCase() },
      archive: !windows,
      binary: windows ? 'agy.exe' : 'antigravity',
    }
  }
}

/**
 * The installed version without starting agy: the Solus copy's version is the
 * one Solus selected. Another copy is asked, with time to unpack.
 */
export async function antigravityVersion(binary: string): Promise<string | null> {
  const executable = agentExecutables.agy
  const selection = executable.selection
  if (selection && executable.owns(binary)) return selection.version
  return readExecutableVersion(binary, undefined, EXTERNAL_VERSION_TIMEOUT_MS)
}

/** The download already matched Google's SHA-512; starting it would only unpack it. */
export async function verifyAntigravityPackage(binary: string): Promise<void> {
  try {
    await access(binary, constants.X_OK)
  } catch {
    throw new Error('The downloaded Google Antigravity package has no executable.')
  }
}
