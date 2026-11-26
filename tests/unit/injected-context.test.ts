import { describe, expect, test } from 'bun:test'
import { stripInjectedContext } from '@solus/server/execution/agents/utils'
import { stripAttachedFileLines } from '@solus/contracts/injected-context'
import { formatTaskContext } from '@solus/server/data/tasks/task-context'

const task = { id: '01KZ4TSYMQRX31D1DK5AAEW5TR', title: 'Task System Testing' }

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
  test('drops the blocks appended after the typed prompt', () => {
    const prompt = ['fix the scroll bug', '', '[Referenced Work: "Notes" (work_id: w1)]'].join('\n')

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
