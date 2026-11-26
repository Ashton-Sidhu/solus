import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SetupAgent } from '@solus/contracts/types'
import type { ProviderInstallation } from '@solus/contracts/host-update-types'
import { isInside } from '../cli-env'

export const softwareVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
export const softwareDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
/** The digest a release publishes for its download. Google publishes SHA-512 for agy (docs/plans/antigravity-provider.md decision 8). */
export interface ReleaseDigest { algorithm: 'sha256' | 'sha512'; hex: string }
export interface NativeRelease { version: string; downloadUrl: string; digest: ReleaseDigest; archive: boolean; binary: string }
export interface SoftwareSourceOptions {
  platform?: NodeJS.Platform
  arch?: string
  baseUrl?: string
  metadata?: (url: string) => Promise<string>
}
export interface ExternalInstallation { method: ProviderInstallation['method']; remediation: string }
export interface AgentSoftwareAdapter {
  readonly agent: SetupAgent
  readonly label: string
  /** Null for an agent that is not published to npm. */
  readonly npmPackage: string | null
  readonly source: 'mirror' | 'vendor'
  detectInstallation(path: string, realPath: string): ExternalInstallation
  release(): Promise<NativeRelease>
  assertCompatible?(): void
  verifyProtocol?(binary: string, env: NodeJS.ProcessEnv): Promise<void>
}

interface InstallationLocations {
  command: SetupAgent
  npmPackage: string | null
  brewPackage: string
  wingetPackage: string
  nativeDirectory: string[]
  nativeRemediation: string
}

/** Resolve package-manager paths after the adapter selects its own locations. */
export function detectExternalInstallation(path: string, realPath: string, locations: InstallationLocations): ExternalInstallation {
  const normalized = realPath.replaceAll('\\', '/')
  const shim = path.replaceAll('\\', '/').toLowerCase()
  if (locations.npmPackage && (normalized.includes(`/node_modules/${locations.npmPackage}/`) || ['cmd', 'ps1'].some((extension) => shim.endsWith(`/npm/${locations.command}.${extension}`)))) {
    return { method: 'npm', remediation: `Run npm install -g ${locations.npmPackage} on this host.` }
  }
  if (/\/(?:Cellar|Caskroom)\//.test(normalized)) return { method: 'homebrew', remediation: `Run brew upgrade ${locations.brewPackage} on this host.` }
  if (/\/Microsoft\/WinGet\//i.test(normalized)) return { method: 'winget', remediation: `Run winget upgrade ${locations.wingetPackage} on this host.` }
  if (isInside(join(homedir(), ...locations.nativeDirectory), realPath)) return { method: 'native', remediation: locations.nativeRemediation }
  return { method: 'external', remediation: `Update ${locations.command} at ${path}, then check again.` }
}

export function assertNativePlatform(agent: SetupAgent, platform: NodeJS.Platform, arch: string): void {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`Native ${agent} installation is not supported on ${platform}/${arch}.`)
}
