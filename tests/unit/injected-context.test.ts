import { describe, expect, test } from 'bun:test'
import { stripInjectedContext } from '@solus/server/execution/agents/utils'
import { stripAttachedFileLines } from '@solus/contracts/injected-context'
import { formatTaskContext } from '@solus/server/data/tasks/task-context'
import { formatLeadContract } from '@solus/server/data/sessions/lead-contract'

const task = { id: '01KZ4TSYMQRX31D1DK5AAEW5TR', title: 'Task System Testing' }

/** The full packet older task-backed sessions carry before the typed text,
 *  from before the packet moved to the system prompt. */
function legacyPacket(extraLines: string[] = []): string {
  return [
    '[Working On Task — "Task System Testing" (task_id: 01KZ4TSYMQRX31D1DK5AAEW5TR, status: in_progress)]',
    'Project: /Users/sidhu/solus',
    ...extraLines,
    '',
    'Check the packet round-trips.',
    '',
    'Comments:',
    '- ashton: still broken on reload',
    '',
    'Work contract:',
    '- Keep this task in progress while you work.',
    '',
    'Call read_task with task_id "01KZ4TSYMQRX31D1DK5AAEW5TR" to refresh this packet; use comment_task and update_task_status for permitted durable write-back.',
  ].join('\n')
}

describe('stripAttachedFileLines', () => {
  test('a title or preview shows the typed text, not the attached file paths', () => {
    // WHY: a video attached to the first prompt named the session and the task
    // "[Attached file: /Users/…/flicker.mp4]" instead of what the user asked.
    const prompt = '[Attached file: /data/attachments/s/0-abc-flicker.mp4]\n[Attached file: /tmp/log.txt]\n\nWhy does the box flicker?'
    expect(stripAttachedFileLines(prompt)).toBe('Why does the box flicker?')
  })

  test('a bracket the user typed without the composer blank line stays', () => {
    const typed = '[Attached file: see below]\nThis is my text'
    expect(stripAttachedFileLines(typed)).toBe(typed)
  })
})

describe('stripInjectedContext', () => {
  test('keeps the typed prompt of a task-backed session', () => {
    // WHY: the task packet is prepended, so treating it like the appended blocks
    // erases the user's turn — and a transcript with no user turn folds its whole
    // history behind one activity row on reload.
    const prompt = `${legacyPacket()}\n\nfix the scroll bug`

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })

  test('keeps the typed prompt when the packet carries an epic', () => {
    // WHY: the epic's description is text from another ticket inside the
    // packet. If the stripper stops at it, that text reads as the user's turn.
    const prompt = `${legacyPacket(['Epic: jira ACME-7 — "Release 2.0" — https://acme.atlassian.net/browse/ACME-7', '  Ship the release.', '', 'Every client in one week.'])}\n\nfix the scroll bug`

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })

  test('a packet with nothing typed after it leaves no user turn', () => {
    expect(stripInjectedContext(legacyPacket())).toBe('')
  })

  test('still drops the blocks appended after the typed prompt', () => {
    const prompt = [
      'fix the scroll bug',
      '',
      '[Working On Task "Task System Testing" (task_id: 01KZ4TSYMQRX31D1DK5AAEW5TR)]',
      'Call read_task with task_id "01KZ4TSYMQRX31D1DK5AAEW5TR" to read the latest status, comments, and linked PRs; call update_task_status to move it.',
    ].join('\n')

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })

  test('strips both a leading packet and a trailing reference block', () => {
    const prompt = [
      legacyPacket(),
      '',
      'fix the scroll bug',
      '',
      '[Referenced Work: "Notes" (work_id: w1)]',
    ].join('\n')

    expect(stripInjectedContext(prompt)).toBe('fix the scroll bug')
  })
})

describe('task lifecycle work contracts', () => {
  test('moderate keeps Done under user control by default', () => {
    const packet = formatTaskContext(task)
    expect(packet).toContain('Do not move it to done; the user closes completed work.')
  })

  test('none tells the agent not to change task status', () => {
    const packet = formatTaskContext(task, 'none')
    expect(packet).toContain("Do not change this task's status")
    expect(packet).not.toContain('Use comment_task and update_task_status')
  })

  test('autonomous permits the agent to finish the task', () => {
    const packet = formatTaskContext(task, 'autonomous')
    expect(packet).toContain('Move it to done when the work is complete without review.')
  })

  // The pull request linking rule is in the runtime instructions of every
  // session that has the link tool. A second copy in the packet repeats it.
  test('the packet does not repeat the pull request linking rule', () => {
    for (const policy of ['none', 'moderate', 'autonomous'] as const) {
      expect(formatTaskContext(task, policy)).not.toContain('link (kind=pr')
    }
  })
})

describe('the lead contract', () => {
  test('a task packet carries no lead contract', () => {
    // WHY: a lead is a session-owned opt-in, not a role of a task. A session
    // linked to a task works on it; it does not coordinate workers for it.
    expect(formatTaskContext(task)).not.toContain('Lead contract:')
  })

  test('holds the coordination rules', () => {
    // WHY: the lead coordinates workers and must keep its own thread small; a
    // contract without these rules lets it implement the work itself and fill
    // a long-lived context window.
    const contract = formatLeadContract({ leadInstructions: '', workerModel: null })
    expect(contract.split('\n')[0]).toBe('Lead contract:')
    expect(contract).toContain('you do not implement beyond very small edits')
    expect(contract).toContain('Start workers with start_session, one worktree each')
    expect(contract).toContain('Keep this thread small')
    // Reports reach the lead together, when its workers are done.
    expect(contract).toContain('You are woken once, when every worker you wait on has finished')
    expect(contract).toContain('Answer the user from reports and read_session.')
  })

  test('does not depend on a task', () => {
    // WHY: a lead is a session the user opts in, not a role of a task. A lead
    // with no task must not be told to read task sessions or to start workers
    // on a task; a task joins only when the lead itself is linked to one.
    const contract = formatLeadContract({ leadInstructions: '', workerModel: null })
    expect(contract).not.toContain('read_task_sessions')
    expect(contract).not.toContain('this task')
    expect(contract).toContain("Start workers with task='none'.")
    expect(contract).toContain("Only when you are linked to a task, start them with task='attempt'")
    expect(contract.match(/task='attempt'/g)).toHaveLength(1)
  })

  test("the user's lead settings follow the lead contract and do not replace it", () => {
    // WHY: the lead settings let a user route workers and add rules to the
    // lead. The built-in contract keeps the lead's thread small, so the user's
    // text extends it rather than taking its place.
    const lead = {
      leadInstructions: 'Send frontend work to Claude Opus.',
      workerModel: { provider: 'codex' as const, model: 'gpt-6', reasoningEffort: 'xhigh' as const },
    }
    const lines = formatLeadContract(lead).split('\n')
    const workerDefault = lines.findIndex((line) => line.includes("agent_provider 'codex', model_id 'gpt-6' and reasoning_effort 'xhigh'"))
    const instructions = lines.indexOf('Send frontend work to Claude Opus.')
    expect(workerDefault).toBeGreaterThan(0)
    expect(instructions).toBeGreaterThan(workerDefault)
    expect(lines).toContain('- Keep this thread small: short reads, short replies. Say what happened, what was produced with its link, and what is open.')
  })

  test('a worker model saved without a reasoning level leaves the level to the model', () => {
    // WHY: a selection saved before reasoning was configurable must still
    // parse, and start_session then uses the model's default level.
    const contract = formatLeadContract({ leadInstructions: '', workerModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: undefined } })
    expect(contract).toContain("agent_provider 'codex', model_id 'gpt-6'.")
    expect(contract).not.toContain('reasoning_effort')
  })

  test('empty lead settings add nothing to the contract', () => {
    expect(formatLeadContract({ leadInstructions: '  ', workerModel: null }))
      .toBe(formatLeadContract({ leadInstructions: '', workerModel: null }))
  })
})

describe('the task packet', () => {
  test('names the task and holds no state that changes while the agent works', () => {
    // WHY: the packet is appended to the system prompt of every run. Status,
    // body and comments in it changed the prompt on every status move or
    // comment, and repeated what read_task returns.
    const packet = formatTaskContext(task)
    expect(packet.split('\n')[0]).toBe('[Working On Task — "Task System Testing" (task_id: 01KZ4TSYMQRX31D1DK5AAEW5TR)]')
    expect(packet).toContain('Call read_task with task_id "01KZ4TSYMQRX31D1DK5AAEW5TR" before you start work.')
    expect(packet).not.toContain('status:')
  })

  test('a task this host cannot read still gets its id and contract', () => {
    const packet = formatTaskContext({ id: 'task-elsewhere' })
    expect(packet.split('\n')[0]).toBe('[Working On Task (task_id: task-elsewhere)]')
    expect(packet).toContain('Work contract:')
  })
})
