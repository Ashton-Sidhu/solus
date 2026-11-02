import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { SetupAgent } from '@solus/contracts/types'
import { normalizeVersion } from '@solus/contracts/version'
import { hostCliEnv, startableCommand } from '../cli-env'

const version = z.string().regex(/^v?\d+\.\d+\.\d+$/)
const releaseSchema = z.object({ tag_name: version, html_url: z.url().startsWith('https://') })
const packageSchema = z.object({ version })
const LOOKUP_TIMEOUT_MS = 10_000
export interface LatestRelease { version: string; url: string }

/** `npm view <spec> version --json` as text, or null when npm is not on this host's PATH. */
export type NpmView = (spec: string) => Promise<string | null>

/** npm applies the user's registry, auth, and proxy settings; a direct fetch of
 *  registry.npmjs.org does not, and a corporate network blocks it. */
const npmView: NpmView = (spec) => new Promise((resolve, reject) => {
  const env = hostCliEnv()
  const command = startableCommand('npm', env)
  execFile(command.file, [...command.args, 'view', spec, 'version', '--json'], { env, timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error?.code === 'ENOENT') return resolve(null)
    // npm's own message can name the registry's auth details: keep it out of the status.
    if (error) return reject(new Error(`npm could not read ${spec}.`))
    resolve(stdout)
  })
})

export async function fetchLatestRelease(target: 'solus' | SetupAgent, currentVersion: string, view: NpmView = npmView): Promise<LatestRelease> {
  if (target !== 'solus') {
    const packageName = target === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'
    const url = `https://www.npmjs.com/package/${packageName}`
    const output = await view(`${packageName}@latest`)
    // Without npm there is no registry setting to honor. With npm, a failed lookup
    // is the answer: public npm may be the registry the user chose not to use.
    if (output !== null) {
      const latest = npmVersion(output)
      if (!latest) throw new Error(`npm returned an unknown version for ${packageName}.`)
      return { version: latest, url }
    }
    const latest = await fetchJson(`https://registry.npmjs.org/${packageName}/latest`, currentVersion, packageSchema)
    return { version: latest.version, url }
  }
  const repo = process.env.SOLUS_RELEASE_REPO || 'Ashton-Sidhu/solus'
  const apiBase = process.env.SOLUS_RELEASE_API_BASE || 'https://api.github.com'
  const release = await fetchJson(`${apiBase}/repos/${repo}/releases/latest`, currentVersion, releaseSchema)
  return { version: normalizeVersion(release.tag_name), url: release.html_url }
}

function npmVersion(output: string): string | null {
  try {
    const parsed = version.safeParse(JSON.parse(output))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function fetchJson<Body>(url: string, currentVersion: string, schema: z.ZodType<Body>): Promise<Body> {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { 'user-agent': `solus-server/${currentVersion}` } })
  if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}.`)
  return schema.parse(await response.json())
}
