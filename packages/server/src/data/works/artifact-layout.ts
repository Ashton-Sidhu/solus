import { replyHtmlLayout } from '@solus/document-model/reply-html-layout'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { ArtifactLayout } from '@solus/contracts/artifact-page'
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
  await saveMeasurements(artifactLayoutId(html), sizes, root)
}

/** Two frame widths this close lay a render out the same way. */
const SAME_FRAME_WIDTH_PX = 4
/** The most widths one render keeps (the store's own limit). */
const MAX_FRAME_WIDTHS = 12

/**
 * Adds one height a client measured at one frame width. A width already known
 * takes the new height; a render that keeps every width it was ever shown at
 * stays within the store's limit by dropping the width nearest the new one.
 */
export function withFrameHeight(sizes: ArtifactMeasurements, width: number, height: number): ArtifactMeasurements {
  const others = sizes.filter(([known]) => Math.abs(known - width) > SAME_FRAME_WIDTH_PX)
  if (others.length >= MAX_FRAME_WIDTHS) {
    let nearest = 0
    for (let index = 1; index < others.length; index++) {
      if (Math.abs(others[index][0] - width) < Math.abs(others[nearest][0] - width)) nearest = index
    }
    others.splice(nearest, 1)
  }
  const measured: [number, number] = [width, height]
  return [...others, measured].sort((a, b) => a[0] - b[0])
}

/**
 * A client measured a reply's HTML frame: kept, so every client that opens the
 * reply later sizes the frame before it loads (`withReplyHtmlLayouts`). Only a
 * dimension is stored, and a wrong one costs one frame a resize.
 */
export async function recordArtifactFrameHeight(attachmentId: string, width: number, height: number, root = dataDir()): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(attachmentId)) return
  const known = await readArtifactMeasurements(attachmentId, root) ?? []
  const next = withFrameHeight(known, width, height)
  if (known.length === next.length && known.every(([w, h], index) => w === next[index][0] && h === next[index][1])) return
  await saveMeasurements(attachmentId, next, root)
}

/** Measurements of one saved artifact version, so a client can size its frame before the page loads. */
function versionLayoutId(workId: string, contentVersion: number): string {
  return artifactLayoutId(`artifact-version\0${workId}\0${contentVersion}`)
}

/** Keeps the frame a save check measured for one saved version, and answers it.
 *  A frame that could not be kept still sizes the live render. */
export async function keepArtifactVersionLayout(workId: string, contentVersion: number, check: { sizes?: ArtifactMeasurements } | null, root = dataDir()): Promise<ArtifactLayout | undefined> {
  const sizes = check?.sizes
  const layout = artifactLayoutOf(sizes)
  if (!sizes || !layout) return undefined
  await saveMeasurements(versionLayoutId(workId, contentVersion), sizes, root).catch(() => {})
  return layout
}

function artifactLayoutOf(sizes: ArtifactMeasurements | undefined): ArtifactLayout | undefined {
  if (!sizes?.length) return undefined
  return { height: Math.max(...sizes.map(([, height]) => height)), heights: sizes }
}

/** Adds the measured frame to each artifact receipt that names a saved version. */
export async function withArtifactLayouts(messages: WireSessionLoadMessage[], root = dataDir()): Promise<WireSessionLoadMessage[]> {
  const result = []
  for (const row of messages) {
    const ref = row.artifactWorkRef
    const layout = ref?.contentVersion
      ? artifactLayoutOf(await readArtifactMeasurements(versionLayoutId(ref.workId, ref.contentVersion), root))
      : undefined
    result.push(ref && layout ? { ...row, artifactWorkRef: { ...ref, layout } } : row)
  }
  return result
}

async function saveMeasurements(id: string, sizes: ArtifactMeasurements, root: string): Promise<void> {
  const directory = join(root, 'artifact-layout')
  const path = join(directory, id)
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
