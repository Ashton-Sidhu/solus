import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SOLUS_AGENT_TOOL_NAMES } from '@solus/contracts/agent-tools'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('@solus/server/agents/tools/solus-toolbox')['solusToolbox']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/agents/tools/solus-toolbox'))
})

describe('Solus toolbox', () => {
  test('every toolbox name is one the clients know', () => {
    // WHY: a client decides from the name alone whether a tool call is Solus's
    // own — which card to draw, which label to print. The renderer used to keep
    // its own copy of this list; it drifted, and calls to real tools rendered as
    // raw provider names. Adding a tool without naming it in the contract puts
    // that bug back, so this fails instead.
    const names = Object.values(solusToolbox).flatMap((group) => Object.values(group)).map((tool) => tool.name)
    const declared = new Set<string>(SOLUS_AGENT_TOOL_NAMES)

    expect(names.filter((name) => !declared.has(name))).toEqual([])
  })

  test('the contract names no tool that has ceased to exist', () => {
    // The other direction of the same drift: three goal tools outlived their
    // implementation in the renderer's copy for as long as nothing checked.
    const inToolbox = new Set(
      Object.values(solusToolbox).flatMap((group) => Object.values(group)).map((tool) => tool.name),
    )
    // Given to one purpose-built run rather than the toolbox, and legitimately
    // absent from it.
    const runScoped = new Set(['submit_review_guide', 'claude_subagent', 'codex_subagent'])

    expect(SOLUS_AGENT_TOOL_NAMES.filter((name) => !inToolbox.has(name) && !runScoped.has(name))).toEqual([])
  })

  test('keeps approval policy on the neutral definition', () => {
    expect(solusToolbox.works.create.requiresApproval).toBe(false)
    expect(solusToolbox.works.update.requiresApproval).toBe(true)
    expect(solusToolbox.tasks.list.requiresApproval).toBe(false)
    expect(solusToolbox.insights.query.requiresApproval).toBe(false)
    expect(solusToolbox.tasks.create.requiresApproval).toBe(true)
    expect(solusToolbox.sessions.prompt.requiresApproval).toBe(false)
    expect(solusToolbox.sessions.stop.requiresApproval).toBe(false)
    // Reading config is free; changing it is a thing the user must see happen.
    expect(solusToolbox.config.read.requiresApproval).toBe(false)
    expect(solusToolbox.config.update.requiresApproval).toBe(true)
  })

  test('addresses provider documents by URL so their site scope is preserved', () => {
    // WHY: a Confluence page id is only unique inside one cloud site. An id-only
    // tool call cannot safely resolve the document it names.
    expect(Object.keys(solusToolbox.docs.read.inputFields)).toEqual(['url'])
    expect(Object.keys(solusToolbox.docs.update.inputFields)).toEqual(['url', 'content', 'title'])
  })

  test('requires an explicit automation worktree choice', () => {
    // WHY: project-root execution is the default. An agent can request isolation,
    // but a cwd inside a worktree must never imply that choice.
    expect(Object.keys(solusToolbox.automations.create.inputFields)).toContain('use_worktree')
    expect(Object.keys(solusToolbox.automations.update.inputFields)).toContain('use_worktree')
  })
})
