import { toHtml } from 'hast-util-to-html'
import type { Element, Root } from 'hast'
import type { Highlighter, BundledLanguage, GrammarState } from 'shiki'

let highlighterPromise: Promise<Highlighter> | undefined

/** Load the grammar only when a code block needs it; share it across mounted tabs. */
export async function loadCodeHighlighter(language: string): Promise<{ highlighter: Highlighter; language: BundledLanguage } | null> {
  const shiki = await import('shiki')
  const normalized = language.toLowerCase().trim()
  function isLanguage(value: string): value is BundledLanguage {
    return Object.hasOwn(shiki.bundledLanguages, value)
  }
  if (!isLanguage(normalized)) return null
  highlighterPromise ??= shiki.createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] }).catch(error => {
    highlighterPromise = undefined
    throw error
  })
  const highlighter = await highlighterPromise
  await highlighter.loadLanguage(normalized)
  return { highlighter, language: normalized }
}

function lineElements(root: Root): Element[] {
  const pre = root.children.find(node => node.type === 'element' && node.tagName === 'pre')
  if (pre?.type !== 'element') return []
  const code = pre.children.find(node => node.type === 'element' && node.tagName === 'code')
  if (code?.type !== 'element') return []
  return code.children.filter((node): node is Element => node.type === 'element')
}

/** Keep the grammar state after complete lines. Only new lines and the unfinished
 * last line are highlighted again. A replacement or CRLF takes the full path. */
export function createIncrementalHighlight(highlighter: Highlighter, language: BundledLanguage) {
  let prefix = ''
  let state: GrammarState | undefined
  let completed: string[] = []
  const options = { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false } as const
  const render = (text: string, grammarState?: GrammarState) => highlighter.codeToHast(text, { ...options, grammarState })
  const htmlLines = (root: Root) => lineElements(root).map(line => toHtml({ type: 'root', children: line.children }))
  return (code: string): string[] => {
    if (!code.startsWith(prefix) || code.includes('\r')) {
      prefix = ''
      state = undefined
      completed = []
    }
    if (code.includes('\r')) return htmlLines(render(code))
    const end = code.lastIndexOf('\n') + 1
    if (end > prefix.length) {
      // Exclude the newline: tokenizing an extra empty line advances state twice.
      const root = render(code.slice(prefix.length, end - 1), state)
      const nextState = highlighter.getLastGrammarState(root)
      if (!nextState) {
        prefix = ''
        state = undefined
        completed = []
        return htmlLines(render(code))
      }
      completed.push(...htmlLines(root))
      prefix = code.slice(0, end)
      state = nextState
    }
    return [...completed, ...htmlLines(render(code.slice(prefix.length), state))]
  }
}

export function plainCodeLines(code: string): string[] {
  return code.split('\n').map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}
