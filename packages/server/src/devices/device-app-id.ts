import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { DeviceCommandRunner } from './device-process'

const appIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,255}$/)
const metadataSchema = z.object({ applicationId: appIdSchema })

/** Gradle metadata names the built variant, including its application-id suffix. */
export async function androidBuildAppId(artifact: string, sdkRoot: string | null, run: DeviceCommandRunner): Promise<string | null> {
  const metadata = await readFile(join(dirname(artifact), 'output-metadata.json'), 'utf8').catch(() => null)
  if (metadata) {
    try {
      const parsed = metadataSchema.safeParse(JSON.parse(metadata))
      if (parsed.success) return parsed.data.applicationId
    } catch { /* Try the APK's own manifest below. */ }
  }
  if (!sdkRoot) return null
  const versions = await readdir(join(sdkRoot, 'build-tools')).catch(() => [])
  for (const version of versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    const aapt = join(sdkRoot, 'build-tools', version, process.platform === 'win32' ? 'aapt.exe' : 'aapt')
    if (!(await stat(aapt).catch(() => null))?.isFile()) continue
    const result = await run(aapt, ['dump', 'badging', artifact], { timeoutMs: 10_000 })
    if (result.code !== 0) continue
    const value = /^package: name='([^']+)'/m.exec(result.stdout)?.[1]
    const parsed = appIdSchema.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return null
}
