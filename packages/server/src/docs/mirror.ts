import { findDiagramEmbeds, parseDiagramEmbed, type DiagramEmbedReference } from '@solus/contracts/diagram-embed'
import type {
  DocDestination,
  DocDiagramAsset,
  DocPatch,
  DocRef,
  NormalizedDoc,
  WorkExternalLink,
  WorkPullResult,
  WorkPublishResult,
} from '@solus/contracts/docs'
import { docProviderAdapter } from './registry'
import { DocProviderUnavailableError, DocVersionConflictError, type DocProviderAdapter } from './types'
import { documentContentHash } from './content-hash'

interface PreparedDocument {
  markdown: string
  diagramAssets?: DocDiagramAsset[]
  lossyParts: string[]
}

/**
 * A publish that carries rendered diagrams keeps its embeds; the provider
 * turns each one into a picture. Without them — an agent publishing from the
 * server, where nothing can draw a canvas — each embed becomes a named caption
 * so the reader is told what is missing rather than shown a bare title.
 */
function prepareDocument(content: string, diagramAssets?: DocDiagramAsset[]): PreparedDocument {
  if (diagramAssets?.length) {
    return { markdown: content, diagramAssets, lossyParts: [] }
  }

  const lossyParts: string[] = []
  const lines = content.split(/\r?\n/).map((line) => {
    const embed = parseDiagramEmbed(line)
    if (!embed) return line
    lossyParts.push(`diagram: ${embed.title}`)
    return `_Diagram: ${embed.title} — view it in Solus._`
  })
  return { markdown: lines.join('\n'), lossyParts }
}

/** The embeds a publish carried as images, and so the ones a later pull can
 *  recognize. Empty when the provider received captions instead. */
function publishedDiagrams(prepared: PreparedDocument): DiagramEmbedReference[] {
  return prepared.diagramAssets?.length ? findDiagramEmbeds(prepared.markdown) : []
}

function linkFrom(doc: NormalizedDoc, destination: DocDestination, content: string, prepared: PreparedDocument): WorkExternalLink {
  const link: WorkExternalLink = {
    ...doc.ref,
    scope: destination.scope,
    lastPushedContentHash: documentContentHash(content),
    syncState: 'ok',
  }
  if (doc.version !== undefined) link.upstreamVersion = doc.version
  const diagrams = publishedDiagrams(prepared)
  if (diagrams.length) link.diagrams = diagrams
  return link
}

/**
 * What a read of the freshly published doc returns, recorded so the next
 * check has something truthful to compare against.
 *
 * A publish knows what it sent, not what the provider stored: Docs re-flows
 * the markdown through its own structure, and Confluence through storage
 * format, so neither round-trips to the byte. Reading once, here, means every
 * later comparison is read-against-read and a version counter that moves on
 * its own can never be mistaken for someone else's edit.
 */
async function upstreamContentHash(
  adapter: DocProviderAdapter,
  ref: DocRef,
  diagrams: DiagramEmbedReference[],
): Promise<string | undefined> {
  try {
    const doc = await adapter.read(ref, diagrams.length ? { diagrams } : undefined)
    return documentContentHash(doc.markdown)
  } catch {
    // The publish itself succeeded. Without a baseline the next check falls
    // back to the version counter, which is the behaviour that existed before.
    return undefined
  }
}

export interface PublishMirrorInput {
  title: string
  content: string
  link?: WorkExternalLink
  destination?: DocDestination
  diagramAssets?: DocDiagramAsset[]
  force?: boolean
}

export async function publishMirror(input: PublishMirrorInput): Promise<WorkPublishResult> {
  const provider = input.link?.provider ?? input.destination?.provider
  if (!provider) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
  const prepared = prepareDocument(input.content, input.diagramAssets)

  try {
    const adapter = docProviderAdapter(provider)
    if (!input.link) {
      if (!input.destination) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
      const created = await adapter.create(input.destination.scope, {
        title: input.title,
        markdown: prepared.markdown,
        diagramAssets: prepared.diagramAssets,
      })
      const link = linkFrom(created, input.destination, input.content, prepared)
      link.upstreamContentHash = await upstreamContentHash(adapter, created.ref, link.diagrams ?? [])
      const result: WorkPublishResult = { ok: true, link }
      if (prepared.lossyParts.length) result.lossyParts = prepared.lossyParts
      return result
    }

    const patch: DocPatch = {
      title: input.title,
      markdown: prepared.markdown,
      diagramAssets: prepared.diagramAssets,
    }
    if (!input.force && input.link.upstreamVersion !== undefined) {
      patch.expectedVersion = input.link.upstreamVersion
    }
    const updated = await adapter.update(input.link, patch)
    const diagrams = publishedDiagrams(prepared)
    const link: WorkExternalLink = {
      ...input.link,
      ...updated.ref,
      lastPushedContentHash: documentContentHash(input.content),
      syncState: 'ok',
      syncError: undefined,
      upstreamVersion: updated.version,
      diagrams: diagrams.length ? diagrams : undefined,
    }
    link.upstreamContentHash = await upstreamContentHash(adapter, updated.ref, diagrams)
    const result: WorkPublishResult = { ok: true, link }
    if (prepared.lossyParts.length) result.lossyParts = prepared.lossyParts
    return result
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (err instanceof DocVersionConflictError && input.link) {
      const link = { ...input.link, syncState: 'conflict' as const, syncError: err.message }
      const result: WorkPublishResult = { ok: false, conflict: true, link }
      if (err.upstreamUpdatedAt) result.upstreamUpdatedAt = err.upstreamUpdatedAt
      return result
    }
    if (input.link) {
      const link: WorkExternalLink = {
        ...input.link,
        syncState: err instanceof DocProviderUnavailableError ? 'auth_error' : 'error',
        syncError: err.message,
      }
      return { ok: false, error: err.message, link }
    }
    return { ok: false, error: err.message }
  }
}

export interface PulledMirror {
  doc: NormalizedDoc
  link: WorkExternalLink
  result: Extract<WorkPullResult, { ok: true }>
}

export async function pullMirror(link: WorkExternalLink): Promise<PulledMirror> {
  const doc = await docProviderAdapter(link.provider).read(link, { diagrams: link.diagrams })
  const refreshed: WorkExternalLink = {
    ...link,
    lastPushedContentHash: documentContentHash(doc.markdown),
    upstreamContentHash: documentContentHash(doc.markdown),
    upstreamVersion: doc.version,
    syncState: 'ok',
    syncError: undefined,
  }
  const result: Extract<WorkPullResult, { ok: true }> = {
    ok: true,
    link: refreshed,
    title: doc.title,
    content: doc.markdown,
  }
  if (doc.lossyParts?.length) result.lossyParts = doc.lossyParts
  return { doc, link: refreshed, result }
}

/**
 * Ask whether the upstream doc says something different from what Solus last
 * read there.
 *
 * The provider's version counter is only a hint, and on Google Docs a
 * misleading one: it moves when Docs commits its own revisions after a write,
 * so a doc that still says exactly what Solus published reports a new version
 * within seconds. The read has the content, so the content decides. The
 * counter is still used to skip the comparison when it has not moved, and the
 * refreshed value is stored whenever the content matches, so an unchanged doc
 * is not re-examined on every poll.
 */
export async function refreshMirror(link: WorkExternalLink): Promise<WorkExternalLink> {
  try {
    const hints = link.diagrams?.length ? { diagrams: link.diagrams } : undefined
    const doc = await docProviderAdapter(link.provider).read(link, hints)
    if (doc.version === undefined || doc.version === link.upstreamVersion) return link

    const upstreamContentHash = documentContentHash(doc.markdown)
    if (link.upstreamContentHash !== undefined && link.upstreamContentHash === upstreamContentHash) {
      // The counter moved, the document did not.
      return { ...link, upstreamVersion: doc.version, syncState: 'ok', syncError: undefined }
    }
    // The version guard keeps the old value on purpose: a publish over an
    // upstream edit must still be refused as a conflict.
    return {
      ...link,
      syncState: 'upstream_changed',
      syncError: undefined,
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return {
      ...link,
      syncState: err instanceof DocProviderUnavailableError ? 'auth_error' : 'error',
      syncError: err.message,
    }
  }
}
