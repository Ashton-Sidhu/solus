import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

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
      'list_works',
      'search_works',
      'read_work',
      'create_work',
      'update_work',
      'read_plan',
      'comment_document',
      'reply_comment',
      'resolve_comment',
      'publish_work',
      'pull_work_upstream',
      'search_docs',
      'read_doc',
      'create_doc',
      'update_doc',
      'import_doc',
      'render_artifact',
      'create_automation',
      'list_automations',
      'read_automation',
      'update_automation',
      'delete_automation',
      'set_automation_enabled',
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
      'list_sessions',
      'read_session',
      'search_sessions',
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
      'link_task_session',
      'link_task',
      'list_prs',
      'read_pr',
      'list_pr_threads',
      'reply_pr_thread',
      'resolve_pr_thread',
      'submit_pr_review',
      'read_config',
      'update_config',
    ])
    expect(new Set(names).size).toBe(names.length)
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
