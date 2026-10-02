import type { Transaction } from '@tiptap/pm/state'

/** A language choice renders Mermaid where the editor supports diagrams.
 *  Editors without that node keep the same source as a normal code block. */
export function setCodeBlockLanguage(transaction: Transaction, position: number, language: string): boolean {
  const node = transaction.doc.nodeAt(position)
  if (node?.type.name !== 'codeBlock') return false
  const mermaidBlock = transaction.doc.type.schema.nodes.mermaidBlock
  if (language === 'mermaid' && mermaidBlock) {
    transaction.replaceWith(position, position + node.nodeSize, mermaidBlock.create({ source: node.textContent }))
  } else {
    transaction.setNodeAttribute(position, 'language', language || null)
  }
  return true
}
