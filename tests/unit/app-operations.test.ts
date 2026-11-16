import { describe, expect, test } from 'bun:test'
import { operationCallersText, operationFields, operationInputTemplate, operationKindLabel, operationTimeLimitText } from '@solus/client-core/app-operations'

// A schema as the build writes it from zod: draft-07, with $schema and additionalProperties.
const SYNC_OUTPUT = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { runs: { type: 'number' }, pipelines: { type: 'array', items: { type: 'object' } } },
  required: ['runs'],
  additionalProperties: false,
}

describe('an operation as the Operations section names it', () => {
  test('the kind says what the operation does to the data, not the API word', () => {
    // WHY: the owner reads "query" and "mutation" as jargon; the page answers whether a run can change data.
    expect(operationKindLabel('query')).toBe('Reads')
    expect(operationKindLabel('mutation')).toBe('Writes')
  })

  test('a schema reads as named fields with plain types, in its own order', () => {
    expect(operationFields(SYNC_OUTPUT)).toEqual([
      { name: 'runs', type: 'number', required: true, description: null },
      { name: 'pipelines', type: 'list of object', required: false, description: null },
    ])
    expect(operationFields({ type: 'object', properties: { mode: { enum: ['fast', 'full'], description: 'How deep.' }, at: { type: ['string', 'null'] } } })).toEqual([
      { name: 'mode', type: 'one of fast, full', required: false, description: 'How deep.' },
      { name: 'at', type: 'text or nothing', required: false, description: null },
    ])
  })

  test('an operation that takes nothing has no field, and a shape the page cannot name falls back to its JSON', () => {
    // WHY: an empty input hides the input box, so a no-input operation runs with one press.
    expect(operationFields({})).toEqual([])
    expect(operationFields({ type: 'object', properties: {} })).toEqual([])
    expect(operationFields({ type: 'object' })).toEqual([])
    expect(operationFields({ type: 'array', items: { type: 'string' } })).toBeNull()
  })

  test('the run form starts from each field with an empty value of its type', () => {
    const template = operationInputTemplate({ type: 'object', properties: { title: { type: 'string' }, limit: { type: 'integer' }, mode: { enum: ['fast', 'full'] }, tags: { type: 'array' } } })
    expect(JSON.parse(template)).toEqual({ title: '', limit: 0, mode: 'fast', tags: [] })
    expect(operationInputTemplate({})).toBe('{}')
  })

  test('the time limit is the host default when the operation declares none', () => {
    expect(operationTimeLimitText(undefined)).toBe('60 s')
    expect(operationTimeLimitText(900)).toBe('15 min')
    expect(operationTimeLimitText(90)).toBe('90 s')
  })

  test('the page says what the operations are for by naming their callers', () => {
    const none = { hasUi: false, schedules: 0, webhooks: 0, workflows: 0, agentAccess: false }
    expect(operationCallersText({ ...none, hasUi: true, schedules: 2, agentAccess: true })).toBe('Its UI, 2 schedules and agents on this host call them.')
    expect(operationCallersText({ ...none, hasUi: true })).toBe('Its UI calls them.')
    expect(operationCallersText({ ...none, schedules: 1 })).toBe('1 schedule calls them.')
    expect(operationCallersText({ ...none, agentAccess: true })).toBe('Agents on this host call them.')
    // WHY: turning agent access off must change the sentence, so the page never claims a caller it does not have.
    expect(operationCallersText(none)).toBe('Nothing calls them yet.')
  })
})
