import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

// work-tools reaches the works store, which opens node:sqlite. Bun stands in
// with its own driver so the tool definitions can be imported in isolation.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { createWorkAgentTool, updateWorkAgentTool } = await import('@solus/server/folio/work-tools')

// The guidance lives on the work tools rather than the system prompt: an agent
// reads it at the moment it considers authoring or revising a work, and it
// cannot drift from the tool it describes.
describe('diagram agent guidance', () => {
  test('create_work teaches diagram-first authoring and live embed tokens', () => {
    expect(createWorkAgentTool.description).toContain('create the diagram work FIRST and embed the token')
    expect(createWorkAgentTool.description).toContain('work://embed')
  })

  test('update_work teaches preservation of an existing live embed', () => {
    expect(updateWorkAgentTool.description).toContain('carry forward any standalone work://embed link')
  })
})
