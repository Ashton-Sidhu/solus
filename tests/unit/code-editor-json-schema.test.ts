import { describe, expect, test } from 'bun:test'
import { operationSchemaNode } from '@solus/client-core/app-operations'
import { codeLanguageOfPath } from '@solus/workspace-ui/components/code-editor/lib/code-languages'
import { jsonCursorAt, jsonSchemaCompletions, jsonSchemaProblems } from '@solus/workspace-ui/components/code-editor/lib/json-schema'

// The shared code editor reads JSON against a schema (docs/plans/apps.md §9.2,
// Operations): the request of an operation completes its fields and marks
// what the operation does not take, before Run sends it.

const ADD_REPOSITORY = operationSchemaNode({
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Who owns the repository.' },
    name: { type: 'string' },
    includePrereleases: { type: 'boolean', description: 'Watch betas too.', default: false },
    limit: { type: 'integer' },
    channel: { enum: ['email', 'slack'] },
    filter: { type: 'object', properties: { label: { type: 'string' } } },
  },
  required: ['owner', 'name'],
})

/** The text with the cursor where `|` is. */
function at(textWithCursor: string): { text: string; pos: number } {
  const pos = textWithCursor.indexOf('|')
  return { text: textWithCursor.slice(0, pos) + textWithCursor.slice(pos + 1), pos }
}

describe('where the cursor is in JSON that does not parse yet', () => {
  test('a key the reader is typing, with the keys the object already has', () => {
    // WHY: the reader is typing; a parser would refuse the text, and the menu must still know the slot.
    const { text, pos } = at('{\n  "owner": "sveltejs",\n  "inc|')
    expect(jsonCursorAt(text, pos)).toEqual({ path: [], slot: 'key', from: text.indexOf('inc'), typed: 'inc', isQuoted: true, keys: ['owner'] })
  })

  test('a value of a nested object names its path', () => {
    const { text, pos } = at('{ "filter": { "label": "bu|" } }')
    expect(jsonCursorAt(text, pos)).toMatchObject({ path: ['filter', 'label'], slot: 'value', typed: 'bu' })
  })

  test('between a key and its colon nothing completes', () => {
    const { text, pos } = at('{ "owner" |')
    expect(jsonCursorAt(text, pos)).toBeNull()
  })
})

describe('completion from the input schema', () => {
  test('a key offers the fields the object does not have yet, with type, required, and the field description', () => {
    const { text, pos } = at('{\n  "owner": "sveltejs",\n  "|')
    const found = jsonSchemaCompletions(text, pos, ADD_REPOSITORY)
    expect(found?.options.map((option) => option.label)).toEqual(['name', 'includePrereleases', 'limit', 'channel', 'filter'])
    const betas = found?.options.find((option) => option.label === 'includePrereleases')
    expect(betas).toMatchObject({ detail: 'boolean', info: 'Watch betas too. Optional, default false.' })
    expect(found?.options.find((option) => option.label === 'name')?.detail).toBe('text · required')
    // In a string the reader opened, the field goes after the quote and the colon follows it.
    expect(betas?.apply).toBe('includePrereleases": ')
  })

  test('a value offers the choices of its field, and true or false for a boolean', () => {
    const choice = at('{ "channel": |')
    expect(jsonSchemaCompletions(choice.text, choice.pos, ADD_REPOSITORY)?.options.map((option) => option.label)).toEqual(['"email"', '"slack"'])
    const flag = at('{ "includePrereleases": t|')
    expect(jsonSchemaCompletions(flag.text, flag.pos, ADD_REPOSITORY)?.options.map((option) => option.label)).toEqual(['true', 'false'])
    // A text field has nothing to offer.
    const free = at('{ "owner": "|')
    expect(jsonSchemaCompletions(free.text, free.pos, ADD_REPOSITORY)).toBeNull()
  })
})

describe('problems against the input schema', () => {
  test('an unknown field with a near name has the near name as its quick fix', () => {
    const text = '{\n  "owner": "a",\n  "name": "b",\n  "includePrerelease": true\n}'
    const [problem] = jsonSchemaProblems(text, ADD_REPOSITORY)
    expect(problem).toMatchObject({ title: 'Unknown field.', line: 4, fix: { label: 'Use includePrereleases', insert: '"includePrereleases"' } })
    // The fix replaces the key, and the document then has no problem.
    const fixed = text.slice(0, problem.from) + problem.fix!.insert + text.slice(problem.to)
    expect(jsonSchemaProblems(fixed, ADD_REPOSITORY)).toEqual([])
  })

  test('a value of the wrong type that plainly means one of the right type has that as its fix', () => {
    const problems = jsonSchemaProblems('{ "owner": "a", "name": "b", "limit": "14", "includePrereleases": "yes" }', ADD_REPOSITORY)
    expect(problems.map((problem) => [problem.title, problem.fix?.insert ?? null])).toEqual([
      ['Wrong type.', '14'],
      ['Wrong type.', null],
    ])
    expect(jsonSchemaProblems('{ "owner": "a", "name": "b", "limit": 1.5 }', ADD_REPOSITORY)[0].message).toBe('limit takes whole number.')
  })

  test('a required field that is absent is a problem on the line of its object', () => {
    expect(jsonSchemaProblems('{\n  "owner": "a"\n}', ADD_REPOSITORY)).toEqual([
      { title: 'A required field is absent.', message: 'Add name.', line: 1, from: 0, to: 1, fix: null },
    ])
  })

  test('text that is not JSON yet has no problem here: Run says why it is not JSON', () => {
    expect(jsonSchemaProblems('{ "owner": ', ADD_REPOSITORY)).toEqual([])
  })
})

describe('the language of a source file', () => {
  test('the step source view colors TypeScript and JavaScript, and JSON as JSON', () => {
    expect(['src/app.ts', 'workflows/release.mjs', 'ui/page.tsx', 'config.json', 'README.md'].map(codeLanguageOfPath)).toEqual(['typescript', 'typescript', 'typescript', 'json', 'text'])
  })
})
