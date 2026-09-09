import { z } from 'zod'
import type { SetupAgent } from '@solus/contracts/types'
import { normalizeVersion } from '@solus/contracts/version'

const version = z.string().regex(/^v?\d+\.\d+\.\d+$/)
const releaseSchema = z.object({ tag_name: version, html_url: z.url().startsWith('https://') })
const packageSchema = z.object({ version })
export interface LatestRelease { version: string; url: string }

export async function fetchLatestRelease(target: 'solus' | SetupAgent, currentVersion: string): Promise<LatestRelease> {
  const repo = process.env.SOLUS_RELEASE_REPO || 'Ashton-Sidhu/solus'
  const packageName = target === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'
  const url = target === 'solus'
    ? `https://api.github.com/repos/${repo}/releases/latest`
    : `https://registry.npmjs.org/${packageName}/latest`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': `solus-server/${currentVersion}` } })
  if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}.`)
  const body = await response.json()
  if (target === 'solus') {
    const release = releaseSchema.parse(body)
    return { version: normalizeVersion(release.tag_name), url: release.html_url }
  }
  return { version: packageSchema.parse(body).version, url: `https://www.npmjs.com/package/${packageName}` }
}
