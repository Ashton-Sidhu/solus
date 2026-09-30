import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { DOCUMENT_SCHEMA_VERSION, documentExtensions } from '@solus/document-model/schema'
import { parseDocumentMarkdown, serializeDocumentMarkdown } from '@solus/document-model/markdown'
import { parseDiagram, serializeDiagram } from '@solus/contracts/diagram-types'
import { readDiagramFromY, writeDiagramToY } from '@solus/contracts/diagram-live'
import { DIAGRAM_LIVE_SCHEMA_VERSION, DOCUMENT_LIVE_FIELD } from '@solus/contracts/work-live'
import type { WorkType } from '@solus/contracts/types'

/**
 * How the host turns a work's stored body into its live doc and back
 * (docs/plans/work-review-and-live-editing.md, phase 3b). A document is a
 * `Y.XmlFragment` built with the same schema the editor uses
 * (`@solus/document-model`); a diagram is the maps of `diagram-live.ts`. The
 * host alone converts, so an agent reads the body people see.
 */

/** The work types people edit live. Artifacts are the agent's; slides are out of scope. */
export type LiveWorkType = Extract<WorkType, 'doc' | 'diagram'>

export function isLiveWorkType(type: WorkType): type is LiveWorkType {
  return type === 'doc' || type === 'diagram'
}

export function liveSchemaVersion(type: LiveWorkType): number {
  return type === 'doc' ? DOCUMENT_SCHEMA_VERSION : DIAGRAM_LIVE_SCHEMA_VERSION
}

let schema: Schema | null = null

/** The document schema, built once: building it is the expensive part. */
function documentSchema(): Schema {
  schema ??= getSchema(documentExtensions())
  return schema
}

/** A new live doc holding the stored body. Only the host seeds one. */
export function seedLiveDoc(type: LiveWorkType, content: string): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    if (type === 'doc') prosemirrorToYXmlFragment(documentSchema().nodeFromJSON(parseDocumentMarkdown(content)), doc.getXmlFragment(DOCUMENT_LIVE_FIELD))
    else writeDiagramToY(doc, parseDiagram(content))
  })
  return doc
}

/**
 * The body the live doc holds, as stored: markdown for a document, JSON for a
 * diagram. It reads a copy, never the live doc: a conversion must not be able
 * to change what people share.
 */
export function projectLiveDoc(type: LiveWorkType, live: Y.Doc): string {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(live))
  if (type === 'diagram') return serializeDiagram(readDiagramFromY(copy))
  return serializeDocumentMarkdown(yXmlFragmentToProseMirrorRootNode(copy.getXmlFragment(DOCUMENT_LIVE_FIELD), documentSchema()).toJSON())
}

/**
 * Make the live doc hold `content`, changing only what differs, so cursors
 * stay in place and offline edits still merge. Run inside the caller's
 * transaction origin; answers nothing, the doc's `update` event carries it.
 */
export function absorbIntoLiveDoc(type: LiveWorkType, live: Y.Doc, content: string, origin: string): void {
  if (type === 'diagram') {
    live.transact(() => writeDiagramToY(live, parseDiagram(content)), origin)
    return
  }
  const node = documentSchema().nodeFromJSON(parseDocumentMarkdown(content))
  live.transact(() => {
    updateYFragment(live, live.getXmlFragment(DOCUMENT_LIVE_FIELD), node, { mapping: new Map(), isOMark: new Map() })
  }, origin)
}
