import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SOLUS_AGENT_TOOL_NAMES } from '@solus/contracts/agent-tools'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('@solus/server/agents/tools/solus-toolbox')['solusToolbox']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/agents/tools/solus-toolbox'))
})

describe('Solus toolbox', () => {
  test('groups every provider-neutral tool exactly once', () => {
    const tools = Object.values(solusToolbox).flatMap((group) => Object.values(group))
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual([
      'find_works',
      'read_work',
      'create_work',
      'update_work',
      'read_plan',
      'comment_document',
      'reply_comment',
      'resolve_comment',
      'publish_work',
      'pull_work_upstream',
      'search_external_doc',
      'read_external_doc',
      'create_external_doc',
      'update_external_doc',
      'import_external_doc',
      'render_artifact',
      'create_automation',
      'list_automations',
      'read_automation',
      'update_automation',
      'delete_automation',
      'run_automation',
      'list_automation_runs',
      'read_automation_run',
      'connection_status',
      'query_insights',
      'browser_status',
      'browser_open',
      'browser_close',
      'browser_navigate',
      'browser_resize',
      'browser_set_appearance',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_evaluate',
      'browser_wait_for',
      'list_agent_targets',
      'find_sessions',
      'read_session',
      'create_session',
      'prompt_session',
      'wait_for_session',
      'stop_session',
      'answer_session',
      'review_plan',
      'list_tasks',
      'read_task',
      'update_task_status',
      'create_task',
      'comment_task',
      'link_task',
      'read_config',
      'update_config',
    ])
    expect(new Set(names).size).toBe(names.length)
  })

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
