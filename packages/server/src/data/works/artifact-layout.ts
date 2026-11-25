import { replyHtmlLayout } from '@solus/document-model/reply-html-layout'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { dataDir } from '../../platform/paths'

const measurements = z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(12)
export type ArtifactMeasurements = z.infer<typeof measurements>

export function artifactLayoutId(html: string): string {
  return createHash('sha256').update(html).digest('hex')
}

/** Only dimensions are kept. A missing preview never delays history for a browser render. */
export async function readArtifactMeasurements(id: string, root = dataDir()): Promise<ArtifactMeasurements | undefined> {
  if (!/^[0-9a-f]{64}$/.test(id)) return
  try {
    return measurements.parse(JSON.parse(await readFile(join(root, 'artifact-layout', id), 'utf8')))
  } catch {
    return undefined
  }
}

export async function saveArtifactMeasurements(html: string, sizes: ArtifactMeasurements, root = dataDir()): Promise<void> {
  const directory = join(root, 'artifact-layout')
  const path = join(directory, artifactLayoutId(html))
  const temporary = path + '.' + randomUUID()
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, JSON.stringify(measurements.parse(sizes)), { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function withReplyHtmlLayouts(messages: WireSessionLoadMessage[]): Promise<WireSessionLoadMessage[]> {
  const result = []
  for (const row of messages) {
    const layout = row.role === 'assistant' ? replyHtmlLayout(row.content, artifactLayoutId) : undefined
    if (!layout) {
      result.push(row)
      continue
    }
    for (const frame of layout) {
      const sizes = await readArtifactMeasurements(frame.attachmentId)
      if (!sizes?.length) continue
      frame.heights = sizes
      frame.height = Math.max(...sizes.map(([, height]) => height))
    }
    result.push({ ...row, replyHtmlLayout: layout })
  }
  return result
}
