import { z } from 'zod'
import { normalizeVersion } from '@solus/contracts/version'

const releaseSchema = z.object({ tag_name: z.string().regex(/^v?\d+\.\d+\.\d+$/), html_url: z.url().startsWith('https://') })
export interface LatestRelease { version: string; url: string }

/** Solus releases only. Each AgentSoftware owns its agent's release source. */
export async function fetchLatestRelease(currentVersion: string): Promise<LatestRelease> {
  const repo = process.env.SOLUS_RELEASE_REPO || 'Ashton-Sidhu/solus'
  const apiBase = process.env.SOLUS_RELEASE_API_BASE || 'https://api.github.com'
  const response = await fetch(`${apiBase}/repos/${repo}/releases/latest`, {
    signal: AbortSignal.timeout(10_000), headers: { 'user-agent': `solus-server/${currentVersion}` },
  })
  if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}.`)
  const release = releaseSchema.parse(await response.json())
  return { version: normalizeVersion(release.tag_name), url: release.html_url }
}
