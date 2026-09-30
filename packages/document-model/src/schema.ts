import type { AnyExtension, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { FrontMatter } from './front-matter'
import { DocumentImage } from './image'
import { DocumentTable } from './table'
import { ArtifactEmbed, DiagramEmbed, HtmlBlock, MermaidBlock } from './blocks'
import { PersonReference } from './person-reference'

/**
 * The version of the document schema below. A client and a host that share a
 * document must agree on it: a schema that does not know a node or a mark
 * deletes that content. Change it whenever a node, a mark, or an attribute is
 * added, removed, or renamed.
 */
export const DOCUMENT_SCHEMA_VERSION = 1

/**
 * Node views the editor puts on the markdown schema's own nodes. Each one must
 * extend the node it replaces (`FrontMatter.extend({ addNodeView })`), so the
 * schema and the markdown stay the ones defined here.
 */
export interface MarkdownNodeViews {
  frontMatter?: Node
  codeBlock?: Node
  image?: Node
  table?: Node
}

/** Node views for the blocks only a work or a plan has. */
export interface DocumentBlockViews {
  personReference?: Node
  diagramEmbed?: Node
  artifactEmbed?: Node
  htmlBlock?: Node
  mermaidBlock?: Node
}

export type DocumentNodeViews = MarkdownNodeViews & DocumentBlockViews

function viewOr(base: Node, view: Node | undefined): Node {
  if (!view) return base
  if (view.name !== base.name) throw new Error(`The ${view.name} view cannot replace the ${base.name} node.`)
  return view
}

/**
 * The rich markdown schema: prose, lists, tables, code, images, front matter.
 * Every rich editor reads and writes markdown through it. Editor behaviour —
 * undo, drop cursor, shortcuts, placeholders — is added by the editor.
 */
export function markdownExtensions(views: MarkdownNodeViews = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      trailingNode: false,
      undoRedo: false,
      dropcursor: false,
      link: { openOnClick: false, autolink: true },
    }),
    viewOr(FrontMatter, views.frontMatter),
    viewOr(CodeBlock, views.codeBlock),
    TaskList,
    TaskItem.configure({ nested: true }),
    viewOr(DocumentImage, views.image).configure({ allowBase64: true }),
    viewOr(DocumentTable, views.table),
    TableRow,
    TableHeader,
    TableCell,
  ]
}

/** The schema of a work or a plan: the markdown schema and its custom blocks.
 *  The host converts work content with exactly this list. */
export function documentExtensions(views: DocumentNodeViews = {}): AnyExtension[] {
  return [
    ...markdownExtensions(views),
    viewOr(PersonReference, views.personReference),
    viewOr(DiagramEmbed, views.diagramEmbed),
    viewOr(ArtifactEmbed, views.artifactEmbed),
    viewOr(HtmlBlock, views.htmlBlock),
    viewOr(MermaidBlock, views.mermaidBlock),
  ]
}
