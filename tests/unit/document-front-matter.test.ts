import { describe, expect, test } from 'bun:test'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { createMarkdownParser } from '../../packages/workspace-ui/src/components/editor/markdownParser'
import {
  FrontMatterMarkdownExtension,
  frontMatterProperties,
  setFrontMatterValue,
} from '../../packages/workspace-ui/src/components/editor/lib/front-matter'

function documentMarkdown() {
  return new MarkdownManager({
    marked: createMarkdownParser(),
    extensions: [StarterKit, FrontMatterMarkdownExtension],
  })
}

const SKILL = [
  '---',
  'name: visual-artifacts',
  'description: Author and render visual, interactive local HTML artifacts.',
  '---',
  '',
  '# Visual artifacts',
  '',
  'Body text.',
].join('\n')

describe('front matter in a document', () => {
  test('a skill file survives open and save byte for byte', () => {
    // WHY: the front matter is read by a tool, not a person. Before this node
    // existed, a save wrote it back as a rule and a heading, and the skill
    // stopped loading.
    const markdown = documentMarkdown()
    const doc = markdown.parse(SKILL)

    expect(doc.content?.[0]).toEqual({
      type: 'frontMatter',
      attrs: {
        yaml: 'name: visual-artifacts\ndescription: Author and render visual, interactive local HTML artifacts.',
      },
    })
    expect(markdown.serialize(doc)).toBe(SKILL)
  })

  test('each key is its own property, not one run-together paragraph', () => {
    expect(frontMatterProperties('name: visual-artifacts\ndescription: "Say \\"hi\\""')).toEqual([
      { key: 'name', value: 'visual-artifacts', isEditable: true },
      { key: 'description', value: 'Say "hi"', isEditable: true },
    ])
  })

  test('a rule later in the document is still a rule', () => {
    // WHY: front matter only opens a document. A `---` pair lower down is the
    // author's horizontal rule or setext heading and must keep that meaning.
    const doc = documentMarkdown().parse('Intro\n\n---\nname: x\n---\n')
    expect(doc.content?.some((node) => node.type === 'frontMatter')).toBe(false)
  })

  test('a rule over prose that is not YAML stays markdown', () => {
    const doc = documentMarkdown().parse('---\nJust a sentence here.\n---\n')
    expect(doc.content?.some((node) => node.type === 'frontMatter')).toBe(false)
  })

  test('lists and block scalars are shown as YAML and not rewritten', () => {
    // WHY: the list edits one-line values only. Rewriting a nested value as a
    // quoted string would silently change what the file means.
    const yaml = 'tags:\n  - one\n  - two\nsummary: |\n  line one\n  line two'
    expect(frontMatterProperties(yaml)).toEqual([
      { key: 'tags', value: '- one\n- two', isEditable: false },
      { key: 'summary', value: '|\nline one\nline two', isEditable: false },
    ])
    expect(setFrontMatterValue(yaml, 'tags', 'three')).toBe(yaml)
  })
})

describe('editing a property', () => {
  test('changes only that line', () => {
    // WHY: comments, order, and the other values belong to the author. An edit
    // that re-emitted the whole block would show up as a diff nobody made.
    const yaml = '# owned by the skill loader\nname: old\ndescription: keep me'
    expect(setFrontMatterValue(yaml, 'name', 'new')).toBe('# owned by the skill loader\nname: new\ndescription: keep me')
  })

  test('quotes a value that plain YAML would read differently', () => {
    // WHY: `a: b` unquoted is a map, and ` #` starts a comment. The value the
    // reader typed must be the value a YAML parser reads back.
    expect(setFrontMatterValue('title: x', 'title', 'Part 1: intro')).toBe('title: "Part 1: intro"')
    expect(setFrontMatterValue('title: x', 'title', 'one #two')).toBe('title: "one #two"')
    expect(setFrontMatterValue('title: x', 'title', 'plain words')).toBe('title: plain words')
  })

  test('a value that was quoted stays quoted', () => {
    // WHY: authors quote a value like "1.0" to keep it a string.
    expect(setFrontMatterValue('version: "1.0"', 'version', '2.0')).toBe('version: "2.0"')
  })
})
