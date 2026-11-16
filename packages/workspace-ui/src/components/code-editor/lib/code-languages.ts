import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'

/**
 * The languages of the shared code editor, and their colors. A stream
 * tokenizer for each is enough: the editor colors the text and does not
 * parse it. The colors are the transcript's code colors, from Solus tokens,
 * so light and dark both read and code reads the same anywhere in Solus.
 */

export type CodeLanguage = 'json' | 'typescript' | 'text'

/** A key is a string that a colon follows. */
function jsonToken(stream: StringStream): string | null {
  if (stream.eatSpace()) return null
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return stream.match(/^\s*:/, false) ? 'propertyName' : 'string'
  if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number'
  if (stream.match(/^(?:true|false|null)\b/)) return 'atom'
  stream.next()
  return 'punctuation'
}

const TS_KEYWORDS = /^(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|interface|let|new|of|return|satisfies|static|switch|throw|try|type|typeof|var|void|while|yield|as)\b/
const TS_ATOMS = /^(?:true|false|null|undefined|this)\b/

interface ScriptState {
  /** In a block comment that goes on to the next line. */
  inComment: boolean
  /** In a template string that goes on to the next line. */
  inTemplate: boolean
}

function scriptToken(stream: StringStream, state: ScriptState): string | null {
  if (state.inComment) {
    state.inComment = !stream.skipTo('*/')
    if (state.inComment) stream.skipToEnd()
    else stream.match('*/')
    return 'comment'
  }
  if (state.inTemplate) {
    state.inTemplate = !readTemplate(stream)
    return 'string'
  }
  if (stream.eatSpace()) return null
  if (stream.match('//')) {
    stream.skipToEnd()
    return 'comment'
  }
  if (stream.match('/*')) {
    state.inComment = true
    return scriptToken(stream, state)
  }
  if (stream.match('`')) {
    state.inTemplate = !readTemplate(stream)
    return 'string'
  }
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string'
  if (stream.match(/^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?/)) return 'number'
  if (stream.match(TS_KEYWORDS)) return 'keyword'
  if (stream.match(TS_ATOMS)) return 'atom'
  if (stream.match(/^[A-Z][\w$]*/)) return 'typeName'
  if (stream.match(/^[a-zA-Z_$][\w$]*(?=\s*\()/)) return 'function'
  if (stream.match(/^[a-zA-Z_$][\w$]*/)) return 'variableName'
  stream.next()
  return 'punctuation'
}

/** Reads a template string to its closing backtick; false when the line ends first. */
function readTemplate(stream: StringStream): boolean {
  while (!stream.eol()) {
    const char = stream.next()
    if (char === '\\') stream.next()
    else if (char === '`') return true
  }
  return false
}

const json = StreamLanguage.define({ name: 'json', token: jsonToken })
const typescript = StreamLanguage.define<ScriptState>({
  name: 'typescript',
  startState: () => ({ inComment: false, inTemplate: false }),
  token: scriptToken,
  tokenTable: { function: tags.function(tags.variableName) },
})

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--solus-text-secondary)' },
  { tag: tags.string, color: 'var(--solus-art-3)' },
  { tag: tags.number, color: 'var(--solus-art-5)' },
  { tag: tags.atom, color: 'var(--solus-art-4)' },
  { tag: tags.keyword, color: 'var(--solus-accent)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName], color: 'var(--solus-art-4)' },
  { tag: tags.punctuation, color: 'var(--solus-text-tertiary)' },
])

/** The language and its colors; plain text has neither. */
export function codeLanguage(language: CodeLanguage): Extension[] {
  switch (language) {
    case 'json':
      return [json, syntaxHighlighting(highlight)]
    case 'typescript':
      return [typescript, syntaxHighlighting(highlight)]
    case 'text':
      return []
  }
}

/** The language of a source file, from its name. */
export function codeLanguageOfPath(path: string): CodeLanguage {
  if (/\.json$/i.test(path)) return 'json'
  if (/\.[cm]?[jt]sx?$/i.test(path)) return 'typescript'
  return 'text'
}
