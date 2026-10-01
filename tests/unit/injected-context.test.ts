import { describe, expect, test } from 'bun:test'
import { stripInjectedContext } from '@solus/server/execution/agents/utils'
import { stripAttachedFileLines } from '@solus/contracts/injected-context'
import { formatTaskContext } from '@solus/server/data/tasks/task-context'

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
    expect(packet).toContain('or done when the work is complete without review')
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
  test('a lead session gets the lead contract after the work contract', () => {
    // WHY: the lead coordinates workers and must keep its own thread small; a
    // packet without these rules lets it implement the task itself and fill a
    // long-lived context window (docs/plans/task-conversation.md).
    const packet = formatTaskContext(task, 'moderate', 'lead')
    const lines = packet.split('\n')
    expect(lines.indexOf('Lead contract:')).toBeGreaterThan(lines.indexOf('Work contract:'))
    expect(packet).toContain('you do not implement beyond very small edits')
    expect(packet).toContain("start_session (task='attempt'")
    expect(packet).toContain('Keep this thread small')
    expect(packet).toContain('call read_task_sessions first')
    // Reports reach the lead together, when its workers are done; re-reading
    // the task after them only grows the thread.
    expect(packet).toContain('You are woken once, when every worker you wait on has finished')
    expect(packet).toContain('After session reports, do not')
  })

  test('a working attempt and a referenced session get no lead contract', () => {
    expect(formatTaskContext(task, 'moderate', 'working')).not.toContain('Lead contract:')
    expect(formatTaskContext(task, 'moderate', 'referenced')).not.toContain('Lead contract:')
    expect(formatTaskContext(task)).not.toContain('Lead contract:')
  })

  test("the user's lead settings follow the lead contract and do not replace it", () => {
    // WHY: Settings → Tasks lets a user route workers and add rules to the
    // lead. The built-in contract keeps the lead's thread small, so the user's
    // text extends it rather than taking its place.
    const lead = {
      leadInstructions: 'Send frontend work to Claude Opus.',
      workerModel: { provider: 'codex' as const, model: 'gpt-6', reasoningEffort: 'xhigh' as const },
    }
    const lines = formatTaskContext(task, 'moderate', 'lead', lead).split('\n')
    const contract = lines.indexOf('Lead contract:')
    const workerDefault = lines.findIndex((line) => line.includes("agent_provider 'codex', model_id 'gpt-6' and reasoning_effort 'xhigh'"))
    const instructions = lines.indexOf('Send frontend work to Claude Opus.')
    expect(contract).toBeGreaterThan(-1)
    expect(workerDefault).toBeGreaterThan(contract)
    expect(instructions).toBeGreaterThan(workerDefault)
    expect(lines).toContain('- Keep this thread small: short reads, short replies. Say what happened, what was produced with its link, and what is open.')
  })

  test('a worker model saved without a reasoning level leaves the level to the model', () => {
    // WHY: a selection saved before reasoning was configurable must still
    // parse, and start_session then uses the model's default level.
    const packet = formatTaskContext(task, 'moderate', 'lead', { leadInstructions: '', workerModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: undefined } })
    expect(packet).toContain("agent_provider 'codex', model_id 'gpt-6'.")
    expect(packet).not.toContain('reasoning_effort')
  })

  test('a worker never receives the lead settings', () => {
    const lead = { leadInstructions: 'Send frontend work to Claude Opus.', workerModel: { provider: 'codex' as const, model: 'gpt-6', reasoningEffort: undefined } }
    const packet = formatTaskContext(task, 'moderate', 'working', lead)
    expect(packet).not.toContain('Send frontend work to Claude Opus.')
    expect(packet).not.toContain('gpt-6')
  })

  test('empty lead settings add nothing to the lead packet', () => {
    expect(formatTaskContext(task, 'moderate', 'lead', { leadInstructions: '  ', workerModel: null }))
      .toBe(formatTaskContext(task, 'moderate', 'lead'))
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
