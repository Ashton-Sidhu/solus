import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { documentExtensions } from '@solus/document-model/schema'
import { parseDocumentMarkdown, serializeDocumentMarkdown } from '@solus/document-model/markdown'
import { DOCUMENT_LIVE_FIELD } from '@solus/contracts/work-live'
import type { WorkType } from '@solus/contracts/types'

/**
 * How the host turns a work's stored body into its live doc and back
 * (docs/plans/work-review-and-live-editing.md, phase 3b). A document is a
 * `Y.XmlFragment` built with the same schema the editor uses
 * (`@solus/document-model`). The host alone converts, so an agent reads the
 * body people see.
 */

/** The work type people edit live. Artifacts are the agent's; slides are out of scope. */
export function isLiveWorkType(type: WorkType): boolean {
  return type === 'doc'
}

let schema: Schema | null = null

/** The document schema, built once: building it is the expensive part. */
function documentSchema(): Schema {
  schema ??= getSchema(documentExtensions())
  return schema
}

/** A new live doc holding the stored body. Only the host seeds one. */
export function seedLiveDoc(content: string): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    prosemirrorToYXmlFragment(documentSchema().nodeFromJSON(parseDocumentMarkdown(content)), doc.getXmlFragment(DOCUMENT_LIVE_FIELD))
  })
  return doc
}

/**
 * The body the live doc holds, as stored: markdown. The reader only reads the
 * doc, so it is read in place: a copy cost as much as the conversion on a large
 * document.
 */
export function projectLiveDoc(live: Y.Doc): string {
  return serializeDocumentMarkdown(yXmlFragmentToProseMirrorRootNode(live.getXmlFragment(DOCUMENT_LIVE_FIELD), documentSchema()).toJSON())
}

/**
 * Make the live doc hold `content`, changing only what differs, so cursors
 * stay in place and offline edits still merge. Run inside the caller's
 * transaction origin; answers nothing, the doc's `update` event carries it.
 */
export function absorbIntoLiveDoc(live: Y.Doc, content: string, origin: string): void {
  const node = documentSchema().nodeFromJSON(parseDocumentMarkdown(content))
  live.transact(() => {
    updateYFragment(live, live.getXmlFragment(DOCUMENT_LIVE_FIELD), node, { mapping: new Map(), isOMark: new Map() })
  }, origin)
}
