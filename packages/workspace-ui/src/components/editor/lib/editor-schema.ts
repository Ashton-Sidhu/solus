import type { AnyExtension } from '@tiptap/core'
import { documentExtensions, markdownExtensions, type DocumentBlockViews } from '@solus/document-model/schema'
import { DocumentTable } from '@solus/document-model/table'
import { lowlight } from '../../../lib/lowlight'
import { DocCodeBlock } from '../codeBlockView'
import { FrontMatterExtension } from '../frontMatterExtension'
import { createDocumentImageView, type ImageSourceResolver } from './document-image-view'

/**
 * The rich editor's schema: the document model's own list, with the editor's
 * node views put on its nodes. There is no second list to keep in step — the
 * host converts markdown with the same `@solus/document-model` definitions.
 *
 * `documentBlocks` is given by a work or a plan. Its presence selects the full
 * document schema; every other rich editor uses the markdown schema.
 */
export function editorSchemaExtensions(
  resolveImage: ImageSourceResolver,
  documentBlocks?: DocumentBlockViews,
): AnyExtension[] {
  const views = {
    frontMatter: FrontMatterExtension,
    codeBlock: DocCodeBlock.configure({ lowlight }),
    image: createDocumentImageView(resolveImage),
    // 5.5px either side of the rule is the design's 11px hit zone, hung on
    // the 1px border itself rather than on a strip beside it. cellMinWidth
    // keeps resized columns readable.
    table: DocumentTable.configure({ resizable: true, handleWidth: 5.5, cellMinWidth: 96 }),
  }
  return documentBlocks ? documentExtensions({ ...views, ...documentBlocks }) : markdownExtensions(views)
}
