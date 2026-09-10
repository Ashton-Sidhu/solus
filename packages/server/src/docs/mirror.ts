import { findDiagramEmbeds, type DiagramEmbedReference } from '@solus/contracts/diagram-embed'
import { parseWorkEmbed } from '@solus/contracts/work-embed'
import type {
  DocDestination,
  DocDiagramAsset,
  DocPatch,
  DocRef,
  DocReadHints,
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
 *
 * An artifact embed always takes the caption. No provider runs HTML, and
 * publishing a render as a picture is out of scope; what matters here is that
 * a `work://` link never reaches a page, where it would read as a broken link.
 */
function prepareDocument(content: string, diagramAssets?: DocDiagramAsset[], existingImages: DiagramEmbedReference[] = []): PreparedDocument {
  const hasAssets = !!diagramAssets?.length
  const lossyParts: string[] = []
  const lines = content.split(/\r?\n/).map((line) => {
    const embed = parseWorkEmbed(line)
    if (!embed) return line
    if (embed.type === 'diagram' && (hasAssets || existingImages.some(image => image.workId === embed.workId))) return line
    lossyParts.push(`${embed.type}: ${embed.title}`)
    const label = embed.type === 'diagram' ? 'Diagram' : 'Artifact'
    return `_${label}: ${embed.title} — view it in Solus._`
  })
  const markdown = lines.join('\n')
  return hasAssets ? { markdown, diagramAssets, lossyParts } : { markdown, lossyParts }
}

/** The embeds a publish carried as images, and so the ones a later pull can
 *  recognize. Empty when the provider received captions instead. */
function publishedDiagrams(prepared: PreparedDocument): DiagramEmbedReference[] {
  const assets = new Map(prepared.diagramAssets?.map((asset) => [asset.workId, asset]))
  return findDiagramEmbeds(prepared.markdown).flatMap((reference) => {
    const asset = assets.get(reference.workId)
    // Google Docs captions use the rendered work's title. The embed label can
    // differ after a rename, so remember the caption the provider received.
    return asset ? [{ workId: reference.workId, title: asset.title }] : []
  })
}

function linkFrom(doc: NormalizedDoc, destination: DocDestination, content: string, prepared: PreparedDocument): WorkExternalLink {
  const link: WorkExternalLink = {
    ...doc.ref,
    googleImages: doc.googleImages,
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

function existingGoogleDiagrams(link: WorkExternalLink | undefined): DiagramEmbedReference[] | undefined {
  if (link?.provider !== 'gdrive') return undefined
  return link.googleImages ?? link.diagrams
}

export async function publishMirror(input: PublishMirrorInput): Promise<WorkPublishResult> {
  const provider = input.link?.provider ?? input.destination?.provider
  if (!provider) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
  const prepared = prepareDocument(input.content, input.diagramAssets, existingGoogleDiagrams(input.link))

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

    // Google can advance Drive versions for comments or deferred revisions.
    // Compare the saved content baseline before treating that as a conflict.
    const currentLink = provider === 'gdrive' && !input.force ? await refreshMirror(input.link) : input.link
    const patch: DocPatch = {
      title: input.title,
      markdown: prepared.markdown,
      diagramAssets: prepared.diagramAssets,
      googleImages: input.link.googleImages,
    }
    if (!input.force && currentLink.upstreamVersion !== undefined) {
      patch.expectedVersion = currentLink.upstreamVersion
    }
    const updated = await adapter.update(input.link, patch)
    const diagrams = updated.googleImages?.map(image => ({ workId: image.workId, title: image.title })) ?? publishedDiagrams(prepared)
    const link: WorkExternalLink = {
      ...input.link,
      ...updated.ref,
      googleImages: updated.googleImages,
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
    return publishFailure(error instanceof Error ? error : new Error(String(error)), input.link)
  }
}

function publishFailure(err: Error, previousLink: WorkExternalLink | undefined): WorkPublishResult {
  if (err instanceof DocVersionConflictError && previousLink) {
    const link = { ...previousLink, syncState: 'conflict' as const, syncError: err.message }
    const result: WorkPublishResult = { ok: false, conflict: true, link }
    if (err.upstreamUpdatedAt) result.upstreamUpdatedAt = err.upstreamUpdatedAt
    return result
  }
  if (previousLink) {
    const link: WorkExternalLink = {
      ...previousLink,
      syncState: err instanceof DocProviderUnavailableError ? 'auth_error' : 'error',
      syncError: err.message,
    }
    return { ok: false, error: err.message, link }
  }
  return { ok: false, error: err.message }
}

export interface PulledMirror {
  doc: NormalizedDoc
  link: WorkExternalLink
  result: Extract<WorkPullResult, { ok: true }>
}

export async function pullMirror(link: WorkExternalLink): Promise<PulledMirror> {
  const doc = await docProviderAdapter(link.provider).read(link, mirrorReadHints(link))
  const refreshed: WorkExternalLink = {
    ...link,
    googleImages: doc.googleImages ?? link.googleImages,
    diagrams: doc.googleImages?.map(image => ({ workId: image.workId, title: image.title })) ?? link.diagrams,
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
function mirrorReadHints(link: WorkExternalLink): DocReadHints | undefined {
  if (!link.diagrams?.length && !link.googleImages?.length) return undefined
  const hints: DocReadHints = { diagrams: link.diagrams }
  if (link.googleImages?.length) hints.googleImages = link.googleImages
  return hints
}

function googleImagesChanged(link: WorkExternalLink, doc: NormalizedDoc): boolean {
  if (!link.googleImages?.length || !doc.googleImages) return false
  return link.googleImages.length !== doc.googleImages.length || link.googleImages.some(image => !doc.googleImages?.some(current => current.objectId === image.objectId && current.sourceUri === image.sourceUri))
}

export async function refreshMirror(link: WorkExternalLink): Promise<WorkExternalLink> {
  try {
    const hints = mirrorReadHints(link)
    const doc = await docProviderAdapter(link.provider).read(link, hints)
    if (googleImagesChanged(link, doc)) return { ...link, syncState: 'upstream_changed', syncError: undefined }
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
