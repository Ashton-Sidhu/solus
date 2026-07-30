import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('../../src/main/agents/tools/solus-toolbox')['solusToolbox']

beforeAll(async () => {
  ;({ solusToolbox } = await import('../../src/main/agents/tools/solus-toolbox'))
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
      'list_sessions',
      'read_session',
      'search_sessions',
      'create_session',
      'prompt_session',
      'wait_for_session',
      'stop_session',
      'list_tasks',
      'read_task',
      'update_task_status',
      'create_task',
      'comment_task',
      'link_task_session',
      'list_prs',
      'read_pr',
      'list_pr_threads',
      'reply_pr_thread',
      'resolve_pr_thread',
      'submit_pr_review',
    ])
    expect(new Set(names).size).toBe(names.length)
  })

  test('keeps approval policy on the neutral definition', () => {
    expect(solusToolbox.works.create.requiresApproval).toBe(false)
    expect(solusToolbox.works.update.requiresApproval).toBe(true)
    expect(solusToolbox.tasks.list.requiresApproval).toBe(false)
    expect(solusToolbox.tasks.create.requiresApproval).toBe(true)
    expect(solusToolbox.sessions.prompt.requiresApproval).toBe(false)
    expect(solusToolbox.sessions.stop.requiresApproval).toBe(false)
  })
})
