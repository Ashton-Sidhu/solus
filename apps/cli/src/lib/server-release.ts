import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { serverReleaseManifestSchema } from '@solus/contracts/server-update'
import { isManagedVersion } from '@solus/contracts/host-install'
import { verifyArchiveSha256 } from './update'
import { versionsDir } from './version-store'

const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.url().startsWith('https://') })),
})

export function readReleaseManifest(installDir: string) {
  return serverReleaseManifestSchema.parse(JSON.parse(readFileSync(join(installDir, 'server-release.json'), 'utf8')))
}

export function assertCompatibleRelease(currentDir: string, nextDir: string, version: string): void {
  readReleaseManifest(currentDir)
  const next = readReleaseManifest(nextDir)
  if (next.version !== version) throw new Error('The release does not match the requested version.')
  if (!isManagedVersion(nextDir)) throw new Error('The release is missing server files.')
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'solus-updater' } })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

export async function runReleaseCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', timeout: 120_000 })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Release command failed (${code}).`)))
  })
}

/** Stage beside `versions/`. Never touch `current` here — the caller
 *  finalizes into `versions/<version>` and activates it only once the
 *  running child confirms it started. */
export async function stageServerRelease(runtimeDir: string, currentDir: string, version: string): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.')
  const repo = process.env.SOLUS_RELEASE_REPO || 'Ashton-Sidhu/solus'
  const apiBase = process.env.SOLUS_RELEASE_API_BASE || 'https://api.github.com'
  const response = await fetch(`${apiBase}/repos/${repo}/releases/tags/v${version}`, {
    signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'solus-updater' },
  })
  if (!response.ok) throw new Error(`Release lookup failed: HTTP ${response.status}`)
  const release = releaseSchema.parse(await response.json())
  if (release.tag_name !== `v${version}` && release.tag_name !== version) throw new Error('Release version mismatch.')
  const artifact = `solus-server-${process.platform}-${process.arch}.tar.gz`
  const asset = release.assets.find((entry) => entry.name === artifact)
  const sums = release.assets.find((entry) => entry.name === 'SHA256SUMS')
  if (!asset || !sums) throw new Error('This release has no server archive for this host.')
  mkdirSync(versionsDir(runtimeDir), { recursive: true })
  const stage = mkdtempSync(join(versionsDir(runtimeDir), '.download-'))
  const next = join(stage, 'install')
  try {
    const archive = join(stage, artifact)
    const checksum = join(stage, 'SHA256SUMS')
    await Promise.all([download(asset.browser_download_url, archive), download(sums.browser_download_url, checksum)])
    verifyArchiveSha256(archive, readFileSync(checksum, 'utf8'), artifact)
    mkdirSync(next)
    await runReleaseCommand('tar', ['-xzf', archive, '-C', next])
    assertCompatibleRelease(currentDir, next, version)
    await runReleaseCommand(join(next, 'bin/node'), ['--version'])
    return next
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}
