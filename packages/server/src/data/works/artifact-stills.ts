import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ArtifactStills } from '@solus/contracts/session-artifacts'
import type { RecordScope } from '../../admission/principal'
import { browserHeadlessHost } from '../../browser/surface-driver'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { writeAssetBytes } from '../assets/assets'
import { renderArtifactStill, type ArtifactPreviewAppearance } from './artifact-preview'
import { loadWork } from './works'

const log = createLogger('folio', 'artifact-stills.ts')

/**
 * A small picture of each `artifact` work, for the cards that show what a
 * session made (docs/plans/session-artifacts.md). An artifact draws itself
 * with script, so its HTML and its text preview say nothing of what it shows;
 * a still of its render does. The host takes one for each appearance the
 * first time a reader lists the work, and again when its content changes.
 * The pictures are assets; a small file named by the work and its content
 * hash points at them.
 */

const stillsSchema = z.object({ light: z.string(), dark: z.string() })

function pointerPath(workId: string, contentHash: string): string {
  return join(dataDir(), 'artifact-stills', `${encodeURIComponent(workId)}.${encodeURIComponent(contentHash)}.json`)
}

/** The stills of this content of the work. Null before the host took them. */
export async function readArtifactStills(workId: string, contentHash: string): Promise<ArtifactStills | null> {
  try {
    return stillsSchema.parse(JSON.parse(await readFile(pointerPath(workId, contentHash), 'utf8')))
  } catch {
    return null
  }
}

/** The content each still was asked for, taken or failed: a reader that lists the work again asks for nothing more until a restart. */
const asked = new Set<string>()
/** One render at a time: each opens a page of the headless browser. */
let queue: Promise<void> = Promise.resolve()

/**
 * Take the stills of this content of the work after every still asked for
 * before it, then call `onTaken`. Nothing happens on a host with no headless
 * browser: its cards keep their icon.
 */
export function requestArtifactStills(scope: RecordScope, workId: string, contentHash: string, onTaken: () => void): void {
  const key = `${workId} ${contentHash}`
  if (asked.has(key) || !browserHeadlessHost()) return
  asked.add(key)
  queue = queue.then(async () => {
    try {
      if (await takeStills(scope, workId, contentHash)) onTaken()
    } catch (error) {
      log.warn('artifact_stills_failed', { workId, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

async function takeStills(scope: RecordScope, workId: string, contentHash: string): Promise<boolean> {
  const work = await loadWork(scope, workId)
  // The work changed or went while it waited; a read of its new content asks again.
  if (!work || work.contentHash !== contentHash || !work.content.trim()) return false
  const stills: ArtifactStills = {
    light: await storeStill(work.content, 'light'),
    dark: await storeStill(work.content, 'dark'),
  }
  const target = pointerPath(workId, contentHash)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(stills))
  await rename(temporary, target)
  return true
}

async function storeStill(html: string, appearance: ArtifactPreviewAppearance): Promise<string> {
  const dataUrl = await renderArtifactStill(html, appearance)
  const stored = await writeAssetBytes(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), 'png')
  return stored.id
}
