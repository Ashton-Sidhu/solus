import type {
  DocDestination,
  DocDraft,
  DocPatch,
  DocProviderStatus,
  DocReadHints,
  DocRef,
  DocScope,
  DocSummary,
  NormalizedDoc,
} from '@solus/contracts/docs'
import { hasGoogleDriveReadScope } from '@solus/contracts/google-auth'
import { getAccessToken, grantedGoogleScopes, isGoogleOAuthConfigured } from '../../google/oauth'
import {
  createEmptyDoc,
  docUrlFor,
  fileMetadata,
  listDocs,
  listFolders,
  renameFile,
  type DriveFile,
  type DriveListOptions,
} from '../../google/drive'
import { getDocument } from '../../google/docs-api'
import { documentToMarkdown } from '../../google/docs-markdown'
import { writeDocsBody } from '../../google/docs-publish'
import { DocProviderUnavailableError, DocVersionConflictError, type DocProviderAdapter } from '../types'
import { validatedDiagramAssets } from '../diagram-assets'

/**
 * Google Docs through Drive.
 *
 * A `DocScope` here is a folder id, or `root` for My Drive; the same string is
 * the `externalKey` persisted in a link, because a Drive doc has no other
 * durable container.
 *
 * Reading a doc Solus did not create needs the `drive.readonly` scope. A grant
 * approved before that scope shipped still publishes, so it stays connected and
 * reports the narrower reach as a `limitation` — an empty search result must
 * never be the only evidence of it.
 */
const DRIVE_READ_LIMITATION =
  'This Google connection can only see documents Solus created. Reconnect Google Drive in Settings → Providers to search and read the rest of the Drive.'

export class GoogleDriveDocAdapter implements DocProviderAdapter {
  readonly id = 'gdrive' as const

  async status(): Promise<DocProviderStatus> {
    if (!isGoogleOAuthConfigured()) {
      // No OAuth client in this build, so there is no sign-in to offer.
      return {
        provider: this.id,
        connected: false,
        reason: 'Google Drive is unavailable in this build of Solus.',
        connectable: false,
      }
    }
    const token = await getAccessToken()
    if (!token) {
      return {
        provider: this.id,
        connected: false,
        reason: 'Google Drive is not connected.',
        connectable: true,
      }
    }
    const status: DocProviderStatus = { provider: this.id, connected: true }
    if (!hasGoogleDriveReadScope(grantedGoogleScopes() ?? undefined)) {
      status.limitation = DRIVE_READ_LIMITATION
    }
    return status
  }

  async destinations(): Promise<DocDestination[]> {
    const token = await this.token()
    const folders = await listFolders(token)
    return [
      { provider: this.id, scope: 'root', label: 'My Drive' },
      ...folders.map((folder) => ({ provider: this.id, scope: folder.id, label: folder.name })),
    ]
  }

  async search(scope: DocScope | undefined, query: string): Promise<DocSummary[]> {
    const token = await this.token()
    const options: DriveListOptions = { query }
    if (scope) options.folderId = scope
    const files = await listDocs(token, options)
    return files.map((file) => {
      const summary: DocSummary = {
        ref: this.ref(file, scope ?? 'root'),
        title: file.name,
        kind: 'document',
      }
      if (file.modifiedTime) summary.updatedAt = file.modifiedTime
      return summary
    })
  }

  async read(ref: DocRef, hints?: DocReadHints): Promise<NormalizedDoc> {
    const token = await this.token()
    const [file, document] = await Promise.all([
      fileMetadata(token, ref.externalId),
      getDocument(token, ref.externalId),
    ])
    const converted = documentToMarkdown(document, hints?.diagrams)
    const doc = this.normalize(file, ref.externalKey, converted.markdown)
    if (converted.lossyParts.length) doc.lossyParts = converted.lossyParts
    return doc
  }

  async create(scope: DocScope, doc: DocDraft): Promise<NormalizedDoc> {
    const token = await this.token()
    const assets = validatedDiagramAssets(doc.diagramAssets)
    const created = await createEmptyDoc(token, doc.title, scope)
    await writeDocsBody(token, created.docId, doc.markdown, assets, scope)
    const file = await fileMetadata(token, created.docId)
    return this.normalize(file, scope, doc.markdown)
  }

  async update(ref: DocRef, patch: DocPatch): Promise<NormalizedDoc> {
    const token = await this.token()
    // Drive v3 takes no write precondition, so the guard is an explicit read
    // first. The race window is small and the alternative — writing blind —
    // would silently destroy an upstream edit.
    if (patch.expectedVersion !== undefined) {
      const current = await fileMetadata(token, ref.externalId)
      if (current.version !== undefined && current.version !== patch.expectedVersion) {
        throw new DocVersionConflictError(current.version, current.modifiedTime)
      }
    }
    const assets = validatedDiagramAssets(patch.diagramAssets)
    await writeDocsBody(token, ref.externalId, patch.markdown, assets, ref.externalKey)
    const updated = patch.title
      ? await renameFile(token, ref.externalId, patch.title)
      : await fileMetadata(token, ref.externalId)
    return this.normalize(updated, ref.externalKey, patch.markdown)
  }

  resolveUrl(url: string): DocRef | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.hostname !== 'docs.google.com' && parsed.hostname !== 'drive.google.com') return null
    const fileId = parsed.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? parsed.searchParams.get('id')
    if (!fileId) return null
    // The containing folder is unknown from a URL alone; `root` is the scope a
    // later publish would use, and reads never consult it.
    return { provider: this.id, externalKey: 'root', externalId: fileId, url: docUrlFor(fileId) }
  }

  private ref(file: DriveFile, scope: DocScope): DocRef {
    return {
      provider: this.id,
      externalKey: scope,
      externalId: file.id,
      url: file.webViewLink ?? docUrlFor(file.id),
    }
  }

  private normalize(file: DriveFile, scope: DocScope, markdown: string): NormalizedDoc {
    const doc: NormalizedDoc = {
      ref: this.ref(file, scope),
      title: file.name,
      markdown,
    }
    if (file.version !== undefined) doc.version = file.version
    if (file.modifiedTime) doc.updatedAt = file.modifiedTime
    return doc
  }

  private async token(): Promise<string> {
    if (!isGoogleOAuthConfigured()) {
      throw new DocProviderUnavailableError(this.id, 'Google Drive is unavailable in this build of Solus.')
    }
    const token = await getAccessToken()
    if (!token) {
      throw new DocProviderUnavailableError(this.id, 'Google Drive is not connected. Connect it in Settings → Providers.')
    }
    return token
  }
}
