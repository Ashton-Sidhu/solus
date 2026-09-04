import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// These actions live in Svelte handlers, so pin their activation policy at the
// source boundary. A foreground resume already activates its tab. Selecting the
// returned tab again toggles the active conversation closed. A split resume must
// stay in the background so the task remains in the leading pane.

const taskPage = readFileSync(
  new URL('../../packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte', import.meta.url),
  'utf8',
)

const reveal = taskPage.slice(
  taskPage.indexOf('async function reveal('),
  taskPage.indexOf('async function openSession('),
)
const open = taskPage.slice(
  taskPage.indexOf('async function openSession('),
  taskPage.indexOf('async function openSessionSplit('),
)
const split = taskPage.slice(
  taskPage.indexOf('async function openSessionSplit('),
  taskPage.indexOf('/** Compose a new session'),
)

describe('task session table navigation', () => {
  test('selects an existing foreground tab but does not select a resumed tab twice', () => {
    // WHY: selectTab on an already-active conversation is an intentional
    // expand/collapse toggle. A second select made Open session look inert.
    expect(reveal).toContain('if (!background) session.selectTab(openTab);')
    expect(reveal).toContain('session.resumeSession(meta, { background })')
    expect(open).not.toContain('session.selectTab(')
  })

  test('resumes split targets in the background', () => {
    // WHY: foreground activation replaces the task page before it can remain
    // beside the requested session.
    expect(split).toContain('reveal(sessionId, true)')
    expect(open).toContain('reveal(sessionId, false)')
  })

  test('reports an unavailable session instead of doing nothing', () => {
    expect(open).toContain('notifySessionUnavailable()')
    expect(split).toContain('notifySessionUnavailable()')
    expect(taskPage).toContain('This task still has the session link')
    expect(taskPage).not.toContain('return session.notifySessionUnavailable()')
  })

  test('uses the page host when a directly opened task frame is not placed yet', () => {
    // WHY: task detail can load through the default host before the Task frame
    // learns that host. Without this fallback, the click never asks any host
    // for session history and incorrectly reports the attempt as deleted.
    expect(reveal).toContain('serverConnections.defaultServerId()')
  })
})
