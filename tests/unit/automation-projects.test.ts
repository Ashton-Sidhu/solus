import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { describe, expect, test } from 'bun:test'
import type { Automation } from '@solus/contracts/types'
import { automationProject, automationProjects } from '@solus/workspace-ui/components/automations/lib/automation-projects'

function automation(id: string, cwd: string): Automation {
  return {
    id,
    name: id,
    enabled: true,
    action: {
      prompt: 'Run checks',
      agentProvider: 'codex',
      modelId: null,
      reasoningEffort: 'medium',
      cwd,
    },
    trigger: { type: 'manual' },
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    createdBy: { kind: 'system' },
  }
}

describe('automation project filter', () => {
  test('builds choices only from projects represented in the full automation list', () => {
    const projects = automationProjects(
      [
        automation('root', '/repos/solus'),
        automation('worktree', '/repos/solus-worktree'),
        automation('standalone', '/repos/tools'),
      ],
      [
        { key: '/repos/solus', label: 'Solus', roots: ['/repos/solus', '/repos/solus-worktree'] },
        { key: '/repos/unused', label: 'Unused', roots: ['/repos/unused'] },
      ],
    )

    expect(projects.map(({ projectPath, count }) => ({ projectPath, count }))).toEqual([
      { projectPath: '/repos/solus', count: 2 },
      { projectPath: '/repos/tools', count: 1 },
    ])
    expect(automationProject(automation('row', '/repos/solus-worktree'), null, projects)?.label).toBe('Solus')
  })

  test('keeps identical project paths on separate hosts distinct', () => {
    const rows = [automation('host-a-row', '/repos/solus'), automation('host-b-row', '/repos/solus')]
    const serverIds = new Map([
      ['host-a-row', 'host-a'],
      ['host-b-row', 'host-b'],
    ])
    const projects = automationProjects(
      rows,
      [],
      (row) => serverIds.get(row.id) ?? null,
      (serverId) => (serverId === 'host-a' ? 'Laptop' : 'Build host'),
    )

    expect(projects.map(({ label, count }) => ({ label, count }))).toEqual([
      { label: 'solus · Build host', count: 1 },
      { label: 'solus · Laptop', count: 1 },
    ])
  })

  test('automations with no project file under one "Chat" choice', () => {
    // WHY: each run of such an automation gets a new chat folder, so the saved
    // marker is what they share, and it must read as a chat, not a path.
    const projects = automationProjects([automation('a', NEW_CHAT_DIRECTORY), automation('b', NEW_CHAT_DIRECTORY)], [])
    expect(projects.map(({ label, count }) => ({ label, count }))).toEqual([{ label: 'Chat', count: 2 }])
  })
})
