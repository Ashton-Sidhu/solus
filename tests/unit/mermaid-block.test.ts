import { describe, expect, test } from 'bun:test'
import {
  isMermaidFence,
  mermaidRenderMode,
} from '../../packages/workspace-ui/src/components/conversation/lib/mermaid-block'
import {
  mermaidBlockFence,
  serializeMermaidBlock,
} from '../../packages/workspace-ui/src/components/editor/lib/mermaid-block-fence'

const FLOWCHART = 'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]'

describe('what a mermaid fence is', () => {
  test('a mermaid fence draws unless the author says source', () => {
    // WHY: unlike html, Mermaid text has no reading other than "draw this",
    // so there is no content test to get wrong. `source` is the one way to
    // keep it as code — the same word an html fence uses, so the agent has
    // one directive to learn.
    expect(mermaidRenderMode('mermaid')).toBe('diagram')
    expect(mermaidRenderMode('mermaid source')).toBe('source')
    expect(mermaidRenderMode('mermaid SOURCE')).toBe('source')
  })

  test('the language is the first word and must be exactly mermaid', () => {
    expect(isMermaidFence('mermaid')).toBe(true)
    expect(isMermaidFence('  mermaid source ')).toBe(true)
    expect(isMermaidFence('mmd')).toBe(false)
    expect(isMermaidFence('html')).toBe(false)
    expect(isMermaidFence(undefined)).toBe(false)
  })
})

describe('a mermaid block in a document', () => {
  test('round-trips byte for byte', () => {
    // WHY: the document's markdown is the file. A round trip that adds or drops
    // a newline rewrites every document containing a diagram the moment it is
    // opened, and every one of those edits shows up as a diff nobody made.
    const markdown = `\`\`\`mermaid\n${FLOWCHART}\n\`\`\``
    const block = mermaidBlockFence(markdown)
    expect(block?.source).toBe(FLOWCHART)
    expect(serializeMermaidBlock(block!.source)).toBe(markdown)
  })

  test('a source fence and other languages are not claimed', () => {
    // WHY: the tokenizer runs before marked's own fence rule. Claiming a fence
    // the reader turned back into code would draw it again on the next open.
    expect(mermaidBlockFence(`\`\`\`mermaid source\n${FLOWCHART}\n\`\`\``)).toBeNull()
    expect(mermaidBlockFence('```ts\nconst a = 1\n```')).toBeNull()
  })

  test('an unclosed fence is left alone', () => {
    // WHY: while an agent streams a document into the editor the fence is
    // open. A diagram must not appear until it closes.
    expect(mermaidBlockFence(`\`\`\`mermaid\n${FLOWCHART}\n`)).toBeNull()
  })

  test('backticks inside the diagram text survive save and reopen', () => {
    // WHY: Mermaid labels may quote code. The fence must grow past the longest
    // backtick run or the block closes early and loses its tail.
    const source = 'flowchart LR\n  A["call ```run```"] --> B'
    const reopened = mermaidBlockFence(serializeMermaidBlock(source))
    expect(reopened?.source).toBe(source)
  })
})
