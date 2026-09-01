import { parseDiagramEmbed } from '@solus/contracts/diagram-embed'
import type {
  DocDestination,
  DocDiagramAsset,
  DocPatch,
  NormalizedDoc,
  WorkExternalLink,
  WorkPullResult,
  WorkPublishResult,
} from '@solus/contracts/docs'
import { docProviderAdapter } from './registry'
import { DocProviderUnavailableError, DocVersionConflictError } from './types'
import { documentContentHash } from './content-hash'

interface PreparedDocument {
  markdown: string
  diagramAssets?: DocDiagramAsset[]
  lossyParts: string[]
}

function prepareDocument(
  provider: DocDestination['provider'],
  content: string,
  diagramAssets?: DocDiagramAsset[],
): PreparedDocument {
  if (provider === 'gdrive' && diagramAssets?.length) {
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
  const prepared = prepareDocument(provider, input.content, input.diagramAssets)

  try {
    const adapter = docProviderAdapter(provider)
    if (!input.link) {
      if (!input.destination) return { ok: false, error: 'Choose a space or folder to publish this document to.' }
      const created = await adapter.create(input.destination.scope, {
        title: input.title,
        markdown: prepared.markdown,
        diagramAssets: prepared.diagramAssets,
      })
      const link = linkFrom(created, input.destination, input.content)
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
    const link: WorkExternalLink = {
      ...input.link,
      ...updated.ref,
      lastPushedContentHash: documentContentHash(input.content),
      syncState: 'ok',
      syncError: undefined,
      upstreamVersion: updated.version,
    }
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
  const doc = await docProviderAdapter(link.provider).read(link)
  const refreshed: WorkExternalLink = {
    ...link,
    lastPushedContentHash: documentContentHash(doc.markdown),
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

export async function refreshMirror(link: WorkExternalLink): Promise<WorkExternalLink> {
  try {
    const doc = await docProviderAdapter(link.provider).read(link)
    if (doc.version === undefined || doc.version === link.upstreamVersion) return link
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
