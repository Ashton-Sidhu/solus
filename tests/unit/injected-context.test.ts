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

  test('keeps the session links and attachments when the provider saved the full prompt', () => {
    const typed = '[Attached file: /tmp/log.txt]\n\nCompare [First](session://ref?sessionId=first&provider=codex) with [Second](session://ref?sessionId=second&provider=claude-code).'
    const prompt = [
      typed,
      '',
      '[Referenced Session: "First" (session_id: first, provider: codex)]',
      'Call read_session with session_id "first" to read its transcript before responding.',
      '',
      '[Referenced Session: "Second\nsession" (session_id: second, provider: claude-code)]',
      'Call read_session with session_id "second" to read its transcript before responding.',
      '',
      '[Referenced Host: "Studio" (host: studio)]',
    ].join('\n')

    expect(stripInjectedContext(prompt)).toBe(typed)
  })

  test('preserves a paragraph that mentions the reference marker', () => {
    const typed = 'What adds this text?\n\n[Referenced Session: "Example"]'
    expect(stripInjectedContext(typed)).toBe(typed)
  })
})

describe('the task packet', () => {
  test('names the task and holds no state that changes while the agent works', () => {
    // WHY: the packet is appended to the system prompt of every run. Status,
    // body and comments in it changed the prompt on every status move or
    // comment, and repeated what read_issue returns.
    const packet = formatTaskContext(task)
    expect(packet.split('\n')[0]).toBe('[Working On Issue — "Task System Testing" (issue_id: 01KZ4TSYMQRX31D1DK5AAEW5TR)]')
    expect(packet).toContain('Call read_issue with issue_id "01KZ4TSYMQRX31D1DK5AAEW5TR" before you start work.')
    expect(packet).not.toContain('status:')
  })

  test('a task this host cannot read still gets its id', () => {
    const packet = formatTaskContext({ id: 'task-elsewhere' })
    expect(packet.split('\n')[0]).toBe('[Working On Issue (issue_id: task-elsewhere)]')
    expect(packet).toContain('Call read_issue with issue_id "task-elsewhere"')
  })
})
