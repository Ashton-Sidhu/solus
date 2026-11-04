import { parseWorkEmbed } from '@solus/contracts/work-embed'
import type {
  DocDestination,
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
  lossyParts: string[]
}

/**
 * No provider runs HTML, and publishing a render as a picture is out of scope,
 * so an artifact embed becomes a named caption: the reader is told what is
 * missing, and a `work://` link never reaches a page, where it would read as a
 * broken link.
 */
function prepareDocument(content: string): PreparedDocument {
  const lossyParts: string[] = []
  const lines = content.split(/\r?\n/).map((line) => {
    const embed = parseWorkEmbed(line)
    if (!embed) return line
    lossyParts.push(`${embed.type}: ${embed.title}`)
    return `_Artifact: ${embed.title} — view it in Solus._`
  })
  return { markdown: lines.join('\n'), lossyParts }
}

function linkFrom(doc: NormalizedDoc, destination: DocDestination, content: string): WorkExternalLink {
  const link: WorkExternalLink = {
    ...doc.ref,
    scope: destination.scope,
    lastPushedContentHash: documentContentHash(content),
    syncState: 'ok',
  }
  if (doc.version !== undefined) link.upstreamVersion = doc.version
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
async function upstreamContentHash(adapter: DocProviderAdapter, ref: DocRef): Promise<string | undefined> {
  try {
    const doc = await adapter.read(ref)
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
  force?: boolean
}

export async function publishMirror(input: PublishMirrorInput): Promise<WorkPublishResult> {
  const provider = input.link?.provider ?? input.destination?.provider
  if (!provider) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
  const prepared = prepareDocument(input.content)

  try {
    const adapter = docProviderAdapter(provider)
    if (!input.link) {
      if (!input.destination) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
      const created = await adapter.create(input.destination.scope, {
        title: input.title,
        markdown: prepared.markdown,
      })
      const link = linkFrom(created, input.destination, input.content)
      link.upstreamContentHash = await upstreamContentHash(adapter, created.ref)
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
    }
    if (!input.force && currentLink.upstreamVersion !== undefined) {
      patch.expectedVersion = currentLink.upstreamVersion
    }
    const updated = await adapter.update(input.link, patch)
    const link: WorkExternalLink = {
      ...input.link,
      ...updated.ref,
      lastPushedContentHash: documentContentHash(input.content),
      syncState: 'ok',
      syncError: undefined,
      upstreamVersion: updated.version,
    }
    link.upstreamContentHash = await upstreamContentHash(adapter, updated.ref)
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
  const doc = await docProviderAdapter(link.provider).read(link)
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
    const doc = await docProviderAdapter(link.provider).read(link)
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
