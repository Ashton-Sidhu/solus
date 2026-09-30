import { refreshWorkExternalComments } from './work-comments'
import type { DocDestination, DocDiagramAsset, WorkExternalLink, WorkPublishResult, WorkPullResult } from '@solus/contracts/docs'
import type { AgentId, Work } from '@solus/contracts/types'
import { workPreview } from '@solus/contracts/work-preview'
import type { RecordScope } from '../../admission/principal'
import { createLogger } from '../../logger'
import { resolveDocUrl } from '../../docs/registry'
import { DocProviderUnavailableError } from '../../docs/types'
import { documentContentHash } from '../../docs/content-hash'
import { publishMirror, pullMirror, refreshMirror } from '../../docs/mirror'
import { createWork, loadWork } from './works'
import { Work as WorkEntity, WorkVersionConflictError, assertWorkEditable } from './work'

const log = createLogger('folio', 'work-sync.ts')

/**
 * Publish and pull — the two explicit directions a linked work moves in.
 *
 * There is no automatic two-way merge, by decision: upstream editors produce
 * structures markdown cannot represent (Docs suggestions, Confluence macros),
 * and a silent merge corrupts pages. Local-first, one direction at a time, with
 * a version guard between them.
 *
 * The agent tools and the work header call these same functions, so link
 * bookkeeping and the conflict guard cannot diverge between the two paths.
 */

/** Slides and diagrams have no publish action in v1; a deck rendered as one
 *  markdown blob would be worse than not publishing it. */
function publishableWork(work: Work | null, workId: string): Work {
  if (!work) throw new Error(`No work found with id "${workId}".`)
  if (work.type !== 'doc') {
    throw new Error(`Only documents can be published upstream. "${work.title}" is a ${work.type}.`)
  }
  return work
}

async function markLink(
  scope: RecordScope,
  workId: string,
  link: WorkExternalLink,
  patch: Partial<WorkExternalLink>,
): Promise<WorkExternalLink> {
  const next: WorkExternalLink = { ...link, ...patch }
  await (await WorkEntity.byId(scope, workId)).setMirroredDoc(next)
  return next
}

export interface PublishWorkOptions {
  /** Required on first publish — the destination picker's answer. Ignored
   *  afterwards: the link remembers where the doc lives. */
  destination?: DocDestination
  diagramAssets?: DocDiagramAsset[]
  /** Publish over an upstream change the user has chosen to discard. */
  force?: boolean
}

export async function publishWork(scope: RecordScope, workId: string, options: PublishWorkOptions = {}): Promise<WorkPublishResult> {
  const { destination, diagramAssets, force } = options
  try {
    const work = publishableWork(await loadWork(scope, workId), workId)
    assertWorkEditable(work)
    const result = await publishMirror({
      title: work.title,
      content: work.content,
      link: work.mirroredDoc,
      destination,
      diagramAssets,
      force,
    })
    if (result.link) await (await WorkEntity.byId(scope, workId)).setMirroredDoc(result.link)
    if (result.ok) log.info('work_published', { workId, provider: result.link.provider, lossy: result.lossyParts?.length ?? 0 })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('work_publish_failed', { workId, error: message })
    return { ok: false, error: message }
  }
}

/**
 * Bring the upstream doc down as a new local version. Safe by construction:
 * works already keep a previous version, so a pull the user dislikes is one
 * revert away.
 */
export async function pullWorkUpstream(scope: RecordScope, workId: string): Promise<WorkPullResult> {
  const work = await loadWork(scope, workId)
  if (!work) return { ok: false, error: `No work found with id "${workId}".` }
  const link = work.mirroredDoc
  if (!link) return { ok: false, error: `"${work.title}" is not linked to an upstream document.` }

  // The body the pull replaces is the one read here, before the provider is
  // asked: a save made while the pull is in flight is kept, and the pull refused.
  const expectedContentVersion = work.contentVersion
  try {
    const pulled = await pullMirror(link)
    const saved = await WorkEntity.byId(scope, workId)
    await saved.applyUpstream({ content: pulled.doc.markdown, title: pulled.doc.title, link: pulled.link, expectedContentVersion })
    return { ...pulled.result, title: saved.title, content: saved.content }
  } catch (err) {
    if (err instanceof WorkVersionConflictError) {
      log.info('work_pull_superseded', { workId, expectedContentVersion })
      return { ok: false, error: `"${work.title}" changed while it was pulled. Nothing was replaced; pull again to bring the upstream document down.` }
    }
    const message = err instanceof Error ? err.message : String(err)
    await markLink(scope, workId, link, {
      syncState: err instanceof DocProviderUnavailableError ? 'auth_error' : 'error',
      syncError: message,
    })
    log.warn('work_pull_failed', { workId, error: message })
    return { ok: false, error: message }
  }
}

/**
 * Ask the provider whether the upstream doc moved, without downloading it.
 * Called only while a linked work is on screen — see the presence-scoped poll —
 * so the chip can say "upstream changed" before a publish is refused.
 */
export async function refreshUpstreamState(scope: RecordScope, workId: string): Promise<WorkExternalLink | null> {
  const work = await loadWork(scope, workId)
  const link = work?.mirroredDoc
  if (!link) return null

  const refreshed = await refreshMirror(link)
  if (refreshed !== link) await (await WorkEntity.byId(scope, workId)).setMirroredDoc(refreshed)
  return refreshed
}

export async function unlinkWork(scope: RecordScope, workId: string): Promise<void> {
  // Deliberately one-sided: the upstream doc is not deleted, moved, or emptied.
  await (await WorkEntity.byId(scope, workId)).setMirroredDoc(null)
}

export interface ImportedDoc {
  work: Work
  link: WorkExternalLink
  /** Named parts of the upstream page markdown could not carry. */
  lossyParts?: string[]
}

export interface ImportDocOptions {
  cwd?: string
  sessionId?: string
  agentProvider?: AgentId
}

/**
 * Create a work from an upstream URL, already linked. Users hand Solus links,
 * so a pasted URL is the whole import: no browser, no picker.
 */
export async function importDocFromUrl(
  organizationId: string,
  url: string,
  options: ImportDocOptions = {},
): Promise<ImportedDoc> {
  const resolved = await resolveDocUrl(url)
  if (!resolved) {
    throw new Error(`"${url}" is not a Confluence page or Google Doc link Solus can import.`)
  }

  const doc = await resolved.adapter.read(resolved.ref)
  const work = await createWork(
    organizationId,
    doc.title,
    'doc',
    doc.markdown,
    workPreview('doc', doc.markdown),
    options.sessionId,
    options.agentProvider ?? 'claude-code',
    options.cwd ?? '~',
    undefined,
    { kind: 'upstream', provider: doc.ref.provider },
  )

  const link: WorkExternalLink = {
    ...doc.ref,
    scope: doc.ref.externalKey.split('/').pop() ?? doc.ref.externalKey,
    lastPushedContentHash: documentContentHash(doc.markdown),
    upstreamContentHash: documentContentHash(doc.markdown),
    syncState: 'ok',
  }
  if (doc.version !== undefined) link.upstreamVersion = doc.version
  await (await WorkEntity.byId(organizationId, work.id)).setMirroredDoc(link)
  if (resolved.adapter.comments) await refreshWorkExternalComments(organizationId, work.id)

  log.info('doc_imported', { workId: work.id, provider: doc.ref.provider })
  const result: ImportedDoc = { work: { ...work, mirroredDoc: link }, link }
  if (doc.lossyParts?.length) result.lossyParts = doc.lossyParts
  return result
}
