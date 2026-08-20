import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Prompt, Session } from '@solus/contracts/types'
import type { TasksStore } from '@solus/workspace-ui/contexts/tasks/tasks.store.svelte'
import type { PlanStore } from '@solus/workspace-ui/contexts/plans/plan.store.svelte'
import type { WorksStore } from '@solus/workspace-ui/contexts/works/works.store.svelte'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'
import { taskBindingSessionId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'

describe('session task binding identity', () => {
  test('a taskless first prompt delays minting until turn settlement', () => {
    // WHY: the agent can link the new session to an existing task during its
    // turn. Minting before that turn finishes creates a second task and a
    // duplicate sidebar occurrence.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )

    expect(source).toMatch(
      /onTurnFinished:[\s\S]*?settleSessionTask\(sessionId\)/,
    )
    expect(source).toMatch(
      /session\.task\.kind !== 'existing'[\s\S]*?skipTaskCreation: true/,
    )
    expect(source).toMatch(
      /settleSessionTask[\s\S]*?findSessionTaskOnHost[\s\S]*?if \(linkedTask\)[\s\S]*?prepareForSession/,
    )

    const serverSource = readFileSync(
      join(import.meta.dir, '../../packages/server/src/control-plane.ts'),
      'utf8',
    )
    expect(serverSource).toContain('options.skipTaskCreation || !options.taskId')
  })

  test('generated session metadata still renames its fallback task', () => {
    // WHY: task minting moved after the turn, but session naming is independent.
    // The loose row must rename immediately and a later fallback task must keep
    // that same generated title and description.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )

    expect(source).toContain('currentSession.title = metadata.title')
    expect(source).toContain('this.generatedTaskMetadataBySession.set(currentSession, metadata)')
    expect(source).toMatch(
      /mintedTaskId[\s\S]*?tasksStore\.update\(mintedTaskId[\s\S]*?title: metadata\.title[\s\S]*?body: metadata\.description/,
    )
  })

  test('a new session draft inherits the active task through the stable session id', () => {
    // WHY: Cmd+T opens a draft from the active conversation. Restored sessions
    // use a Solus task-link id that differs from the provider thread id, so the
    // task picker falls back to "New task" if this lookup uses agentSessionId.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )

    expect(source).toMatch(
      /rootTaskIdFor[\s\S]*?taskForSession\(taskBindingSessionId\(anchor\)\)/,
    )
  })

  test('the project panel resolves the active task from the stable session id', () => {
    // WHY: restored and completed sessions can have a provider thread id that
    // differs from the durable id stored on their task attempt. The Task section
    // must use the durable identity or it disappears from the active rail.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/project-panel/ProjectPanel.svelte'),
      'utf8',
    )

    expect(source).toContain('panelSession ? taskBindingSessionId(panelSession) : null')
    expect(source).toContain('session.tasksStore.taskForSession(panelTaskSessionId)')
    expect(source).toContain('currentSessionId={panelTaskSessionId}')
  })

  test('a regular session uses its stable Solus id after restoration', () => {
    const session = {
      id: 'solus-session',
      agentSessionId: 'provider-session',
    }

    // WHY: the provider thread id is replaceable and differs from the id used
    // to restore the tab. A task linked under it disappears after restart, so a
    // follow-up cannot reopen a completed task.
    expect(taskBindingSessionId(session)).toBe('solus-session')
  })

  test('a handoff keeps its stable Solus id when the provider thread changes', () => {
    const session = {
      id: 'original-solus-session',
      handoffId: 'solus-session',
      agentSessionId: 'second-provider-session',
    }

    // WHY: using the provider id here makes the first prompt after a handoff mint
    // a second task, which the sidebar then renders beside the original attempt.
    expect(taskBindingSessionId(session)).toBe('solus-session')
  })

  test('the prompt keeps the original task after a provider handoff', () => {
    const requestedSessionIds: Array<string | null | undefined> = []
    const tasksStore = {
      tasks: [{ id: 'task-1', title: 'Testing Handoff Feature' }],
      taskForSession: (sessionId: string | null | undefined) => {
        requestedSessionIds.push(sessionId)
        return sessionId === 'solus-session'
          ? { id: 'task-1', title: 'Testing Handoff Feature' }
          : null
      },
    } as unknown as TasksStore
    const composer = new PromptComposer(
      { get: () => null } as unknown as PlanStore,
      { get: () => null } as unknown as WorksStore,
      tasksStore,
    )
    const prompt = {
      planRefs: [],
      workRefs: [],
      sessionRefs: [],
      attachments: [],
    } as unknown as Prompt
    const session = {
      id: 'original-solus-session',
      handoffId: 'solus-session',
      agentSessionId: null,
      task: { kind: 'new' },
      boundWorkId: null,
    } as unknown as Session

    const composed = composer.compose('Continue the work', prompt, session)

    expect(requestedSessionIds).toEqual(['solus-session'])
    expect(composed).toContain('[Working On Task "Testing Handoff Feature" (task_id: task-1)]')
  })
})
